import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { validateMessages, validateMode, ValidationError } from "./lib/chat.js";
import { createGemini, describeError } from "./lib/gemini.js";

// Load variables from .env if the file exists (Node 20.12+).
try {
  process.loadEnvFile();
} catch {
  // No .env file - rely on the real environment.
}

const here = path.dirname(fileURLToPath(import.meta.url));

const modelList = (value, fallback) =>
  (value ?? fallback)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

const config = {
  port: Number(process.env.PORT) || 3000,
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
  baseUrl: process.env.GEMINI_BASE_URL || undefined,
  model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  fallbackModels: modelList(process.env.GEMINI_FALLBACK_MODELS, "gemini-flash-latest,gemini-flash-lite-latest"),
  imageModel: process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image",
  imageFallbackModels: modelList(process.env.GEMINI_IMAGE_FALLBACK_MODELS, "gemini-3.1-flash-lite-image"),
  suggestionsModel: process.env.GEMINI_SUGGESTIONS_MODEL || "gemini-flash-lite-latest",
  followUps: process.env.FOLLOW_UP_SUGGESTIONS !== "false",
  maxTokens: Number(process.env.MAX_TOKENS) || 8192,
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE) || 30,
};

const SYSTEM_PROMPT = `You are Nova, a friendly and knowledgeable AI assistant in a web chat app.

- Answer accurately and directly. If you are not sure about something, say so instead of guessing.
- Keep answers concise by default; go into depth when the user asks for detail or the question needs it.
- Format with Markdown when it helps: short paragraphs, bullet lists, tables, and fenced code blocks with a language tag.
- Users can attach images, PDFs and text files. When they do, use them to answer.
- The app can also create images: if the user asks you to draw or generate one, tell them to switch on Image mode (the 🎨 button below the message box).`;

const gemini = createGemini(config);

const app = express();
app.disable("x-powered-by");
// Large enough for a few base64-encoded attachments (see LIMITS in lib/chat.js).
app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(here, "public")));

// Simple in-memory, per-IP rate limiter for the AI endpoints.
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const entry = hits.get(req.ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(req.ip, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  if (++entry.count > config.rateLimitPerMinute) {
    res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
    return res.status(429).json({
      error: {
        code: "rate_limited",
        message: "You're sending messages too quickly. Please wait a moment.",
        retryable: true,
      },
    });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
}, 60_000).unref();

function sendValidationError(res, err) {
  return res.status(400).json({
    error: { code: "invalid_request", message: err.message, retryable: false },
  });
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    model: config.model,
    imageModel: config.imageModel,
    apiKeyConfigured: Boolean(config.apiKey),
    features: { followUps: config.followUps },
  });
});

/**
 * Streams the assistant's reply as Server-Sent Events:
 *   data: {"type":"delta","text":"..."}
 *   data: {"type":"image","mimeType":"image/png","data":"<base64>"}   (image mode)
 *   data: {"type":"done","stopReason":"end_turn","model":"..."}
 *   data: {"type":"error","error":{...}}
 * Errors that happen before any output are returned as a normal JSON error
 * response with a matching HTTP status instead.
 */
app.post("/api/chat", rateLimit, async (req, res) => {
  let messages;
  let mode;
  try {
    messages = validateMessages(req.body?.messages);
    mode = validateMode(req.body?.mode);
  } catch (err) {
    if (err instanceof ValidationError) return sendValidationError(res, err);
    throw err;
  }

  let started = false;
  const startStream = () => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  };
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // Stop generating (and stop using quota) if the browser goes away.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  try {
    const events = gemini.streamReply({ system: SYSTEM_PROMPT, messages, signal: abort.signal, mode });
    for await (const event of events) {
      startStream();
      if (event.type === "text") send({ type: "delta", text: event.text });
      else if (event.type === "image") send({ type: "image", mimeType: event.mimeType, data: event.data });
      else if (event.type === "done") send({ type: "done", stopReason: event.stopReason, model: event.model });
    }
    res.end();
  } catch (err) {
    if (abort.signal.aborted) return; // client disconnected

    const info = describeError(err, { mode });
    console.error(`[chat:${mode}] ${info.code}:`, err?.message ?? err);
    if (!started) {
      return res.status(info.status).json({ error: info });
    }
    send({ type: "error", error: info });
    res.end();
  }
});

/** Returns up to 3 suggested follow-up questions for a conversation. */
app.post("/api/suggestions", rateLimit, async (req, res) => {
  if (!config.followUps) return res.json({ suggestions: [] });

  let messages;
  try {
    messages = validateMessages(req.body?.messages, { requireUserLast: false });
  } catch (err) {
    if (err instanceof ValidationError) return sendValidationError(res, err);
    throw err;
  }

  try {
    const suggestions = await gemini.suggestFollowUps({ messages, signal: AbortSignal.timeout(15_000) });
    res.json({ suggestions });
  } catch (err) {
    // Suggestions are optional - never surface their failures as chat errors.
    console.warn("[suggestions]", describeError(err).code);
    res.json({ suggestions: [] });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({
    error: { code: "not_found", message: "Unknown API route.", retryable: false },
  });
});

// Malformed or oversized JSON bodies and any other unhandled errors.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: { code: "too_large", message: "Those attachments are too large. Try fewer or smaller files.", retryable: false },
    });
  }
  const status = err.type === "entity.parse.failed" ? 400 : err.status || 500;
  if (status >= 500) console.error("[server]", err);
  res.status(status).json({
    error: {
      code: status === 400 ? "invalid_request" : "server_error",
      message: status === 400 ? "The request body isn't valid JSON." : "Something went wrong on the server.",
      retryable: status >= 500,
    },
  });
});

app.listen(config.port, () => {
  console.log(`Nova chatbot running at http://localhost:${config.port}`);
  console.log(`Chat model: ${config.model} (fallbacks: ${config.fallbackModels.join(", ") || "none"})`);
  console.log(`Image model: ${config.imageModel} (fallbacks: ${config.imageFallbackModels.join(", ") || "none"})`);
  if (!config.apiKey) {
    console.warn("Warning: GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
});
