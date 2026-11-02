import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMessages, validateMode, ValidationError, LIMITS } from "../lib/chat.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("accepts a valid conversation", () => {
  const messages = validateMessages([
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" },
    { role: "user", content: "How are you?", extra: "ignored" },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" },
    { role: "user", content: "How are you?" },
  ]);
});

test("rejects bad input", () => {
  assert.throws(() => validateMessages(undefined), ValidationError);
  assert.throws(() => validateMessages([]), ValidationError);
  assert.throws(() => validateMessages([{ role: "system", content: "x" }]), ValidationError);
  assert.throws(() => validateMessages([{ role: "user", content: "   " }]), ValidationError);
  assert.throws(() => validateMessages([{ role: "user", content: 42 }]), ValidationError);
  assert.throws(
    () => validateMessages([{ role: "user", content: "x".repeat(LIMITS.maxMessageChars + 1) }]),
    ValidationError,
  );
  assert.throws(
    () => validateMessages([{ role: "user", content: "Hi" }, { role: "assistant", content: "Yo" }]),
    /last message/,
  );
});

test("allows an assistant message last when asked (follow-up suggestions)", () => {
  const messages = validateMessages(
    [{ role: "user", content: "Hi" }, { role: "assistant", content: "Yo" }],
    { requireUserLast: false },
  );
  assert.equal(messages.length, 2);
});

test("trims long histories and starts with a user turn", () => {
  const long = Array.from({ length: LIMITS.maxMessages + 5 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
  }));
  const messages = validateMessages(long);
  assert.ok(messages.length <= LIMITS.maxMessages);
  assert.equal(messages[0].role, "user");
  assert.equal(messages.at(-1).content, long.at(-1).content);
});

test("accepts image and text attachments, even without message text", () => {
  const [msg] = validateMessages([
    {
      role: "user",
      content: "",
      attachments: [
        { kind: "inline", name: "dot.png", mimeType: "image/png", data: PNG_BASE64 },
        { kind: "text", name: "notes.txt", text: "hello" },
      ],
    },
  ]);
  assert.deepEqual(msg.attachments, [
    { kind: "inline", name: "dot.png", mimeType: "image/png", data: PNG_BASE64 },
    { kind: "text", name: "notes.txt", text: "hello" },
  ]);
});

test("rejects unsafe or oversized attachments", () => {
  const send = (attachments, role = "user") => () => validateMessages([{ role, content: "x", attachments }]);
  assert.throws(send([{ kind: "inline", name: "a.exe", mimeType: "application/x-msdownload", data: "AAAA" }]), /unsupported/);
  assert.throws(send([{ kind: "inline", name: "a.png", mimeType: "image/png", data: "not base64!" }]), /base64/);
  assert.throws(send([{ kind: "inline", name: "big.png", mimeType: "image/png", data: "A".repeat(10 * 1024 * 1024) }]), /too large/);
  assert.throws(send([{ kind: "text", name: "big.txt", text: "x".repeat(LIMITS.maxTextFileChars + 1) }]), /too long/);
  assert.throws(send(Array(LIMITS.maxAttachments + 1).fill({ kind: "text", name: "a.txt", text: "a" })), /up to/);
  assert.throws(send([{ kind: "text", name: "a.txt", text: "a" }], "assistant"), /Only user messages/);
});

test("validates the mode", () => {
  assert.equal(validateMode(undefined), "chat");
  assert.equal(validateMode("image"), "image");
  assert.throws(() => validateMode("video"), ValidationError);
});
