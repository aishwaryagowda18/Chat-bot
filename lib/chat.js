export const LIMITS = {
  // Only the most recent messages are sent to the model to keep requests small.
  maxMessages: 40,
  maxMessageChars: 8000,
  maxAttachments: 5,
  maxFileBytes: 7 * 1024 * 1024, // per image / PDF, after base64 decoding
  maxTextFileChars: 200_000,
  maxTotalBytes: 20 * 1024 * 1024, // all attachments in one request
};

// Files sent to Gemini as inline data. Text files are sent as plain text instead.
export const INLINE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

export const MODES = new Set(["chat", "image"]);

export class ValidationError extends Error {}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function validateAttachment(att, where) {
  if (!att || typeof att !== "object") throw new ValidationError(`${where} is invalid.`);
  const name = typeof att.name === "string" ? att.name.slice(0, 200) : "file";

  if (att.kind === "text") {
    if (typeof att.text !== "string") throw new ValidationError(`${where} must include its text.`);
    if (att.text.length > LIMITS.maxTextFileChars) {
      throw new ValidationError(`"${name}" is too long. Text files are limited to ${LIMITS.maxTextFileChars} characters.`);
    }
    return { kind: "text", name, text: att.text };
  }

  if (att.kind === "inline") {
    if (!INLINE_MIME_TYPES.has(att.mimeType)) {
      throw new ValidationError(`"${name}" has an unsupported file type.`);
    }
    if (typeof att.data !== "string" || !att.data || !BASE64.test(att.data)) {
      throw new ValidationError(`${where} must be base64-encoded.`);
    }
    const bytes = Math.floor((att.data.length * 3) / 4);
    if (bytes > LIMITS.maxFileBytes) {
      throw new ValidationError(`"${name}" is too large. Files are limited to ${LIMITS.maxFileBytes / 1024 / 1024} MB.`);
    }
    return { kind: "inline", name, mimeType: att.mimeType, data: att.data, bytes };
  }

  throw new ValidationError(`${where} has an unknown kind.`);
}

/**
 * Validates the chat history sent by the browser. User messages may carry
 * attachments; a message needs text, attachments, or both.
 * Throws ValidationError with a user-readable message.
 * @param {unknown} input
 * @param {{ requireUserLast?: boolean }} [options]
 * @returns {{ role: "user" | "assistant", content: string, attachments?: object[] }[]}
 */
export function validateMessages(input, { requireUserLast = true } = {}) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ValidationError("`messages` must be a non-empty array.");
  }

  let totalBytes = 0;
  const messages = input.map((msg, i) => {
    if (!msg || typeof msg !== "object") {
      throw new ValidationError(`Message ${i} must be an object.`);
    }
    if (msg.role !== "user" && msg.role !== "assistant") {
      throw new ValidationError(`Message ${i} has an invalid role.`);
    }
    if (typeof msg.content !== "string") {
      throw new ValidationError(`Message ${i} must have text content.`);
    }
    if (msg.content.length > LIMITS.maxMessageChars) {
      throw new ValidationError(
        `Messages are limited to ${LIMITS.maxMessageChars} characters.`,
      );
    }

    let attachments = [];
    if (msg.attachments !== undefined) {
      if (!Array.isArray(msg.attachments)) throw new ValidationError(`Message ${i} has invalid attachments.`);
      if (msg.role !== "user") throw new ValidationError("Only user messages can have attachments.");
      if (msg.attachments.length > LIMITS.maxAttachments) {
        throw new ValidationError(`You can attach up to ${LIMITS.maxAttachments} files per message.`);
      }
      attachments = msg.attachments.map((att, j) => validateAttachment(att, `Attachment ${j} of message ${i}`));
      for (const att of attachments) totalBytes += att.bytes ?? att.text.length;
    }

    if (msg.content.trim() === "" && attachments.length === 0) {
      throw new ValidationError(`Message ${i} must have text content.`);
    }

    const clean = { role: msg.role, content: msg.content };
    if (attachments.length) clean.attachments = attachments.map(({ bytes, ...att }) => att);
    return clean;
  });

  if (totalBytes > LIMITS.maxTotalBytes) {
    throw new ValidationError("These attachments are too large to send together. Try fewer or smaller files.");
  }
  if (requireUserLast && messages.at(-1).role !== "user") {
    throw new ValidationError("The last message must come from the user.");
  }

  // Keep the tail of the conversation, and make sure it starts with a user turn.
  const trimmed = messages.slice(-LIMITS.maxMessages);
  while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  if (!trimmed.length) throw new ValidationError("The conversation must include a user message.");
  return trimmed;
}

/** Validates the optional `mode` field: "chat" (default) or "image". */
export function validateMode(mode) {
  if (mode === undefined || mode === null) return "chat";
  if (!MODES.has(mode)) throw new ValidationError('`mode` must be "chat" or "image".');
  return mode;
}
