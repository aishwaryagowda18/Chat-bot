import { GoogleGenAI, ApiError, Type } from "@google/genai";

export class NotConfiguredError extends Error {}

// Finish reasons that mean Gemini blocked or withheld the reply.
const BLOCKED_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
]);

const FOLLOW_UP_PROMPT = `You suggest follow-up questions for a chat app.
Given a conversation, return exactly 3 short follow-up questions the user is likely to ask next.
- Write them from the user's point of view, in the same language as the conversation.
- Keep each one under 10 words, specific to the conversation, and different from each other.
- Return only a JSON array of strings.`;

/** Maps a Gemini finish reason to the stop reasons the frontend understands. */
export function mapFinishReason(reason) {
  if (reason === "MAX_TOKENS") return "max_tokens";
  if (BLOCKED_REASONS.has(reason)) return "refusal";
  return "end_turn";
}

/** Converts validated chat messages (with optional attachments) into Gemini `contents`. */
export function toContents(messages) {
  return messages.map((msg) => {
    const parts = [];
    for (const att of msg.attachments ?? []) {
      if (att.kind === "text") parts.push({ text: `Attached file "${att.name}":\n\n${att.text}` });
      else parts.push({ inlineData: { mimeType: att.mimeType, data: att.data } });
    }
    if (msg.content) parts.push({ text: msg.content });
    return { role: msg.role === "assistant" ? "model" : "user", parts };
  });
}

/**
 * Errors worth retrying on the next fallback model: the model is overloaded,
 * rate-limited, timed out, or no longer available.
 */
export function shouldTryNextModel(err) {
  return err instanceof ApiError && [404, 429, 500, 503, 504].includes(err.status);
}

/**
 * Creates a Gemini client for the chatbot.
 *
 * `streamReply` is an async generator that yields
 *   { type: "text", text }          for each piece of the reply,
 *   { type: "image", mimeType, data } for each generated image (image mode), then
 *   { type: "done", stopReason, model } once it finishes.
 * If the main model fails before replying, the fallback models are tried in order.
 */
export function createGemini({
  apiKey,
  model,
  fallbackModels = [],
  imageModel,
  imageFallbackModels = [],
  suggestionsModel,
  maxTokens,
  baseUrl,
  client,
}) {
  const chatModels = [model, ...fallbackModels.filter((m) => m && m !== model)];
  const imageModels = [imageModel, ...imageFallbackModels.filter((m) => m && m !== imageModel)];

  function getClient() {
    if (!apiKey && !client) throw new NotConfiguredError("GEMINI_API_KEY is not set.");
    // The SDK retries 5 times with up to 60s waits by default, which looks like a
    // frozen chat. Retry once, quickly, and rely on the fallback models instead.
    client ??= new GoogleGenAI({
      apiKey,
      httpOptions: {
        retryOptions: { attempts: 2, initialDelay: 1, maxDelay: 2 },
        ...(baseUrl ? { baseUrl } : {}),
      },
    });
    return client;
  }

  return {
    model,
    imageModel,

    async *streamReply({ system, messages, signal, mode = "chat" }) {
      const ai = getClient();
      const models = mode === "image" ? imageModels : chatModels;
      const config =
        mode === "image"
          ? { responseModalities: ["TEXT", "IMAGE"], abortSignal: signal }
          : { systemInstruction: system, maxOutputTokens: maxTokens, abortSignal: signal };

      let stream;
      let usedModel;
      for (const [i, candidateModel] of models.entries()) {
        try {
          stream = await ai.models.generateContentStream({
            model: candidateModel,
            contents: toContents(messages),
            config,
          });
          usedModel = candidateModel;
          break;
        } catch (err) {
          if (signal?.aborted || i === models.length - 1 || !shouldTryNextModel(err)) throw err;
          console.warn(`[gemini] ${candidateModel} failed (${err.status}); trying ${models[i + 1]}`);
        }
      }

      let finishReason;
      let modelVersion;
      for await (const chunk of stream) {
        if (chunk.promptFeedback?.blockReason) finishReason = "PROHIBITED_CONTENT";
        modelVersion = chunk.modelVersion ?? modelVersion;
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) finishReason = candidate.finishReason;

        // Skip "thought" parts (reasoning and draft images) so only the final answer reaches the user.
        let text = "";
        for (const part of candidate?.content?.parts ?? []) {
          if (part.thought) continue;
          if (part.text) text += part.text;
          else if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("image/")) {
            if (text) yield { type: "text", text };
            text = "";
            yield { type: "image", mimeType: part.inlineData.mimeType, data: part.inlineData.data };
          }
        }
        if (text) yield { type: "text", text };
      }

      yield { type: "done", stopReason: mapFinishReason(finishReason), model: modelVersion ?? usedModel };
    },

    /** Returns up to 3 short follow-up questions for the conversation (best effort). */
    async suggestFollowUps({ messages, signal }) {
      const ai = getClient();
      const transcript = messages
        .slice(-6)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 2000)}`)
        .join("\n\n");

      const response = await ai.models.generateContent({
        model: suggestionsModel,
        contents: [{ role: "user", parts: [{ text: transcript }] }],
        config: {
          systemInstruction: FOLLOW_UP_PROMPT,
          responseMimeType: "application/json",
          responseSchema: { type: Type.ARRAY, items: { type: Type.STRING } },
          maxOutputTokens: 256,
          abortSignal: signal,
        },
      });

      return parseSuggestions(response.text);
    },
  };
}

/** Parses and cleans the model's JSON list of follow-up questions. */
export function parseSuggestions(text) {
  let list;
  try {
    list = JSON.parse(text ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => typeof s === "string" && s.trim())
    .map((s) => s.trim().slice(0, 120))
    .slice(0, 3);
}

/** Pulls the human-readable message out of Gemini's (sometimes nested JSON) error text. */
function errorDetail(err) {
  let text = err.message ?? "";
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(text);
      text = parsed?.error?.message ?? text;
    } catch {
      break;
    }
  }
  return String(text).slice(0, 300);
}

/**
 * Maps an error from the Gemini SDK (or anything else) to an HTTP status and
 * a message that is safe to show in the UI.
 * @param {unknown} err
 * @param {{ mode?: "chat" | "image" }} [context]
 * @returns {{ status: number, code: string, message: string, retryable: boolean }}
 */
export function describeError(err, { mode = "chat" } = {}) {
  if (err instanceof NotConfiguredError) {
    return {
      status: 500,
      code: "not_configured",
      message: "No Gemini API key is configured. Add GEMINI_API_KEY to your .env file and restart the server.",
      retryable: false,
    };
  }

  if (err instanceof ApiError) {
    const detail = errorDetail(err);
    if (/api key|api_key/i.test(detail) && [400, 401, 403].includes(err.status)) {
      return {
        status: 401,
        code: "auth_error",
        message: "The server's Gemini API key is invalid. Check GEMINI_API_KEY in your .env file.",
        retryable: false,
      };
    }
    if (err.status === 403) {
      return {
        status: 403,
        code: "permission_error",
        message: "This Gemini API key doesn't have access to the configured model.",
        retryable: false,
      };
    }
    if (err.status === 404) {
      return {
        status: 404,
        code: "not_found",
        message:
          mode === "image"
            ? "The configured image model wasn't found. Check GEMINI_IMAGE_MODEL in your .env file."
            : "The configured Gemini model wasn't found. Check GEMINI_MODEL in your .env file.",
        retryable: false,
      };
    }
    if (err.status === 429) {
      return {
        status: 429,
        code: "rate_limited",
        message:
          mode === "image"
            ? "Image generation hit your Gemini quota. The free tier usually doesn't include image models, so enable billing in Google AI Studio (or wait and try again)."
            : "The Gemini rate limit or free-tier quota was reached. Please wait a moment and try again.",
        retryable: true,
      };
    }
    if (err.status === 400) {
      return {
        status: 400,
        code: "bad_request",
        message: `The request was rejected: ${detail}`,
        retryable: false,
      };
    }
    if (err.status >= 500) {
      return {
        status: 503,
        code: "overloaded",
        message: "Gemini is experiencing high demand right now. Please try again in a moment.",
        retryable: true,
      };
    }
    return {
      status: err.status || 500,
      code: "api_error",
      message: "The Gemini service returned an unexpected error. Please try again.",
      retryable: true,
    };
  }

  // Node's fetch() rejects with "TypeError: fetch failed" on network problems.
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) {
    return {
      status: 502,
      code: "connection_error",
      message: "Couldn't reach the Gemini service. Check the server's internet connection.",
      retryable: true,
    };
  }

  return {
    status: 500,
    code: "server_error",
    message: "Something went wrong on the server. Please try again.",
    retryable: true,
  };
}
