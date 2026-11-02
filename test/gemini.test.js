import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@google/genai";
import {
  describeError,
  mapFinishReason,
  toContents,
  parseSuggestions,
  NotConfiguredError,
  createGemini,
} from "../lib/gemini.js";

test("converts chat messages to Gemini contents", () => {
  assert.deepEqual(
    toContents([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ]),
    [
      { role: "user", parts: [{ text: "Hi" }] },
      { role: "model", parts: [{ text: "Hello!" }] },
    ],
  );
});

test("sends attachments as inline data and text parts", () => {
  const [content] = toContents([
    {
      role: "user",
      content: "What's in these?",
      attachments: [
        { kind: "inline", name: "a.png", mimeType: "image/png", data: "AAAA" },
        { kind: "text", name: "notes.txt", text: "hello" },
      ],
    },
  ]);
  assert.deepEqual(content.parts, [
    { inlineData: { mimeType: "image/png", data: "AAAA" } },
    { text: 'Attached file "notes.txt":\n\nhello' },
    { text: "What's in these?" },
  ]);
});

test("image mode uses the image model and yields generated images", async () => {
  const requests = [];
  const client = {
    models: {
      async generateContentStream(request) {
        requests.push(request);
        return (async function* () {
          yield { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "DRAFT" }, thought: true }] } }] };
          yield { candidates: [{ content: { parts: [{ text: "Here you go!" }, { inlineData: { mimeType: "image/png", data: "FINAL" } }] }, finishReason: "STOP" }] };
        })();
      },
    },
  };
  const gemini = createGemini({ model: "chat-model", imageModel: "image-model", client });
  const events = [];
  for await (const event of gemini.streamReply({ system: "sys", messages: [{ role: "user", content: "a cat" }], mode: "image" })) {
    events.push(event);
  }
  assert.equal(requests[0].model, "image-model");
  assert.deepEqual(requests[0].config.responseModalities, ["TEXT", "IMAGE"]);
  assert.deepEqual(events, [
    { type: "text", text: "Here you go!" },
    { type: "image", mimeType: "image/png", data: "FINAL" },
    { type: "done", stopReason: "end_turn", model: "image-model" },
  ]);
});

test("parses follow-up suggestions defensively", () => {
  assert.deepEqual(parseSuggestions('["One?", " Two? ", "", 5, "Three?", "Four?"]'), ["One?", "Two?", "Three?"]);
  assert.deepEqual(parseSuggestions("not json"), []);
  assert.deepEqual(parseSuggestions('{"a":1}'), []);
  assert.deepEqual(parseSuggestions(undefined), []);
});

test("asks the suggestions model for a JSON list", async () => {
  let request;
  const client = {
    models: {
      async generateContent(req) {
        request = req;
        return { text: '["Tell me more?", "Any examples?", "Why?"]' };
      },
    },
  };
  const gemini = createGemini({ model: "m", suggestionsModel: "lite", client });
  const suggestions = await gemini.suggestFollowUps({
    messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }],
  });
  assert.equal(request.model, "lite");
  assert.equal(request.config.responseMimeType, "application/json");
  assert.deepEqual(suggestions, ["Tell me more?", "Any examples?", "Why?"]);
});

test("maps Gemini finish reasons", () => {
  assert.equal(mapFinishReason("STOP"), "end_turn");
  assert.equal(mapFinishReason(undefined), "end_turn");
  assert.equal(mapFinishReason("MAX_TOKENS"), "max_tokens");
  assert.equal(mapFinishReason("SAFETY"), "refusal");
  assert.equal(mapFinishReason("PROHIBITED_CONTENT"), "refusal");
});

test("refuses to call the API without a key", async () => {
  const gemini = createGemini({ apiKey: "", model: "gemini-flash-latest", maxTokens: 100 });
  await assert.rejects(
    gemini.streamReply({ system: "", messages: [{ role: "user", content: "hi" }] }).next(),
    NotConfiguredError,
  );
});

test("falls back to the next model when one is overloaded", async () => {
  const calls = [];
  const client = {
    models: {
      async generateContentStream({ model }) {
        calls.push(model);
        if (model === "busy-model") throw new ApiError({ status: 503, message: "high demand" });
        return (async function* () {
          yield { modelVersion: model, candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "Hi" }] } }] };
          yield { candidates: [{ content: { parts: [{ text: " there" }] }, finishReason: "STOP" }] };
        })();
      },
    },
  };
  const gemini = createGemini({ model: "busy-model", fallbackModels: ["backup-model"], maxTokens: 100, client });

  const events = [];
  for await (const event of gemini.streamReply({ system: "", messages: [{ role: "user", content: "hi" }] })) {
    events.push(event);
  }
  assert.deepEqual(calls, ["busy-model", "backup-model"]);
  assert.deepEqual(events, [
    { type: "text", text: "Hi" },
    { type: "text", text: " there" },
    { type: "done", stopReason: "end_turn", model: "backup-model" },
  ]);
});

test("does not fall back on errors like an invalid key", async () => {
  const calls = [];
  const client = {
    models: {
      async generateContentStream({ model }) {
        calls.push(model);
        throw new ApiError({ status: 400, message: "API key not valid." });
      },
    },
  };
  const gemini = createGemini({ model: "a", fallbackModels: ["b"], maxTokens: 100, client });
  await assert.rejects(gemini.streamReply({ system: "", messages: [{ role: "user", content: "hi" }] }).next(), ApiError);
  assert.deepEqual(calls, ["a"]);
});

test("maps Gemini errors to friendly responses", () => {
  const invalidKey = describeError(
    new ApiError({
      status: 400,
      message: JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }),
    }),
  );
  assert.equal(invalidKey.code, "auth_error");
  assert.equal(invalidKey.retryable, false);

  const quota = describeError(new ApiError({ status: 429, message: "Resource exhausted" }));
  assert.equal(quota.status, 429);
  assert.equal(quota.retryable, true);
  const imageQuota = describeError(new ApiError({ status: 429, message: "Resource exhausted" }), { mode: "image" });
  assert.match(imageQuota.message, /billing/);

  assert.equal(describeError(new ApiError({ status: 404, message: "model not found" })).code, "not_found");
  assert.equal(describeError(new ApiError({ status: 503, message: "overloaded" })).code, "overloaded");
  assert.equal(describeError(new NotConfiguredError("no key")).code, "not_configured");
  assert.equal(describeError(new TypeError("fetch failed")).code, "connection_error");

  const unknown = describeError(new Error("boom"));
  assert.equal(unknown.status, 500);
  assert.doesNotMatch(unknown.message, /boom/);
});
