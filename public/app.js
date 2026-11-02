import { renderMarkdown, escapeHtml } from "./markdown.js";
import { saveFile, loadFile, deleteFiles, allFileIds, fileUrl, cachedFileUrl, blobToBase64 } from "./files.js";

const STORAGE_KEY = "nova.conversations.v1";
const ACTIVE_KEY = "nova.activeConversation";
const THEME_KEY = "nova.theme";
const MAX_CHARS = 8000;
const MAX_CONVERSATIONS = 50;
const MAX_ATTACHMENTS = 5;
const MAX_FILE_BYTES = 7 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const MAX_IMAGE_SIDE = 2048;
// Only the most recent messages resend their attachments, to keep requests small.
const ATTACHMENT_HISTORY = 10;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|js|mjs|cjs|ts|tsx|jsx|py|java|c|h|cpp|cs|go|rb|php|html?|css|xml|ya?ml|sql|sh|log|ini|toml)$/i;

const SUGGESTIONS = [
  { emoji: "💡", title: "Explain a concept", prompt: "Explain how large language models work, in simple terms." },
  { emoji: "✍️", title: "Help me write", prompt: "Write a short, friendly email asking my manager for a day off next Friday." },
  { emoji: "🧑‍💻", title: "Write some code", prompt: "Write a JavaScript function that checks whether a string is a palindrome, with a few test cases." },
  { emoji: "🗺️", title: "Plan a trip", prompt: "Plan a 3-day budget-friendly trip to Jaipur with a day-by-day itinerary." },
  { emoji: "📊", title: "Compare options", prompt: "Compare SQL and NoSQL databases in a short table, and say when to use each." },
  { emoji: "🎨", title: "Create an image", prompt: "A cozy reading nook with plants and warm sunset light, digital painting", mode: "image" },
];

const ICONS = {
  bot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
  retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0114-5.3L20 9M20 4v5h-5M20 12a8 8 0 01-14 5.3L4 15M4 20v-5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/></svg>',
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.6 4.8L18 9.4l-4.4 1.6L12 16l-1.6-5L6 9.4l4.4-1.6z"/></svg>',
};

const TYPING_HTML =
  '<span class="typing" role="status" aria-label="Nova is typing"><span></span><span></span><span></span></span>';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $("sidebar"),
  scrim: $("scrim"),
  menuBtn: $("menuBtn"),
  newChatBtn: $("newChatBtn"),
  search: $("searchInput"),
  history: $("historyList"),
  main: $("main"),
  messages: $("messages"),
  composer: $("composer"),
  composerBox: $("composerBox"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  attachBtn: $("attachBtn"),
  fileInput: $("fileInput"),
  attachTray: $("attachTray"),
  imageModeBtn: $("imageModeBtn"),
  modeChip: $("modeChip"),
  modeChipClose: $("modeChipClose"),
  micBtn: $("micBtn"),
  counter: $("counter"),
  exportBtn: $("exportBtn"),
  clearBtn: $("clearBtn"),
  themeBtn: $("themeBtn"),
  status: $("status"),
  statusText: $("statusText"),
  banner: $("banner"),
  dropOverlay: $("dropOverlay"),
  dialog: $("confirmDialog"),
  dialogTitle: $("confirmTitle"),
  dialogText: $("confirmText"),
  dialogOk: $("confirmOk"),
  toast: $("toast"),
};

// ---------- Storage (wrapped: storage can be unavailable or full) ----------
const storage = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function loadConversations() {
  const saved = storage.read(STORAGE_KEY, []);
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages))
    .map((c) => ({
      ...c,
      // Drop empty assistant placeholders left behind if the page closed mid-reply.
      messages: c.messages.filter(
        (m) =>
          m &&
          typeof m.content === "string" &&
          (m.content || m.error || m.note || m.images?.length || m.role === "user"),
      ),
    }));
}

// ---------- State ----------
let conversations = loadConversations();
let activeId = storage.read(ACTIVE_KEY, null);
let streaming = null; // { controller, convId, msg, mode }
let stickToBottom = true;
let serverHealthy = true;
let saveWarningShown = false;
let features = { followUps: true };
let pending = []; // attachments waiting to be sent: { id, kind, name, mimeType, size }
let imageMode = false;
let editingId = null;
let searchQuery = "";

const activeConversation = () => conversations.find((c) => c.id === activeId) ?? null;
const fileIdsOfMessage = (m) => [...(m.attachments ?? []), ...(m.images ?? [])].map((f) => f.id);
const fileIdsOfConversation = (c) => c.messages.flatMap(fileIdsOfMessage);

function ensureConversation() {
  let conv = activeConversation();
  if (!conv) {
    conv = { id: uid(), title: "New chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    conversations.unshift(conv);
    activeId = conv.id;
  }
  return conv;
}

function save() {
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  const dropped = conversations.slice(MAX_CONVERSATIONS);
  conversations = conversations.slice(0, MAX_CONVERSATIONS);
  if (dropped.length) deleteFiles(dropped.flatMap(fileIdsOfConversation));
  const ok =
    storage.write(STORAGE_KEY, conversations.filter((c) => c.messages.length)) &&
    storage.write(ACTIVE_KEY, activeId);
  if (!ok && !saveWarningShown) {
    saveWarningShown = true;
    showToast("Chat history couldn't be saved in this browser.");
  }
}

function makeTitle(text) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || "New chat";
}

// ---------- Helpers ----------
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatWhen(ts) {
  const date = new Date(ts);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return formatTime(ts);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

let toastTimer;
function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for non-secure contexts (e.g. http on a LAN address).
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  showToast("Copied to clipboard");
}

function downloadUrl(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function confirmAction({ title, text, ok }) {
  if (typeof els.dialog.showModal !== "function") return Promise.resolve(window.confirm(text));
  els.dialogTitle.textContent = title;
  els.dialogText.textContent = text;
  els.dialogOk.textContent = ok;
  els.dialog.returnValue = "";
  els.dialog.showModal();
  return new Promise((resolve) => {
    els.dialog.addEventListener("close", () => resolve(els.dialog.returnValue === "confirm"), { once: true });
  });
}

function setStatus(kind, text) {
  els.status.className = `status ${kind}`;
  els.statusText.textContent = text;
}

function refreshStatus() {
  if (streaming) setStatus("busy", streaming.mode === "image" ? "Creating image…" : "Typing…");
  else if (!navigator.onLine) setStatus("offline", "You're offline");
  else if (!serverHealthy) setStatus("offline", "Server unreachable");
  else setStatus("online", "Online");
}

function showBanner(text, kind = "warning") {
  if (!text) {
    els.banner.hidden = true;
    return;
  }
  els.banner.textContent = text;
  els.banner.className = `banner${kind === "error" ? " error" : ""}`;
  els.banner.hidden = false;
}

/** Fills in <img data-file-id> elements from stored files. */
function hydrateImages(root) {
  for (const img of root.querySelectorAll("img[data-file-id]:not([src])")) {
    const id = img.dataset.fileId;
    fileUrl(id).then((url) => {
      if (url) {
        img.src = url;
        img.addEventListener("load", () => scrollToBottom(), { once: true });
      } else {
        img.closest(".att-thumb, .gen-image, .tray-item")?.classList.add("missing");
        img.alt = "Image no longer available";
      }
    });
  }
}

function imgTag(id, alt) {
  const src = cachedFileUrl(id);
  return `<img data-file-id="${id}" alt="${escapeHtml(alt)}"${src ? ` src="${src}"` : ""}>`;
}

// ---------- Rendering ----------
function findMatch(conv, query) {
  if (conv.title.toLowerCase().includes(query)) return { snippet: null };
  for (const msg of conv.messages) {
    const index = msg.content.toLowerCase().indexOf(query);
    if (index !== -1) {
      const start = Math.max(0, index - 20);
      const text = msg.content.slice(start, index + query.length + 40).replace(/\s+/g, " ");
      return { snippet: `${start > 0 ? "…" : ""}${text}…` };
    }
    const file = msg.attachments?.find((a) => a.name.toLowerCase().includes(query));
    if (file) return { snippet: `📎 ${file.name}` };
  }
  return null;
}

function renderHistory() {
  const query = searchQuery.trim().toLowerCase();
  const items = conversations
    .filter((c) => c.messages.length)
    .map((c) => ({ c, match: query ? findMatch(c, query) : { snippet: null } }))
    .filter((item) => item.match);

  if (!items.length) {
    els.history.innerHTML = query
      ? `<p class="history-empty">No chats match “${escapeHtml(searchQuery.trim())}”.</p>`
      : '<p class="history-empty">No chats yet. Start a conversation!</p>';
    return;
  }
  els.history.innerHTML = items
    .map(
      ({ c, match }) => `
      <div class="history-item${c.id === activeId ? " active" : ""}" data-id="${c.id}">
        <button type="button" class="history-open" data-action="open"${c.id === activeId ? ' aria-current="true"' : ""}>
          <span class="history-title">${escapeHtml(c.title)}</span>
          <span class="history-time">${match.snippet ? escapeHtml(match.snippet) : formatWhen(c.updatedAt)}</span>
        </button>
        <button type="button" class="history-delete" data-action="delete" aria-label="Delete chat: ${escapeHtml(c.title)}" title="Delete chat">${ICONS.trash}</button>
      </div>`,
    )
    .join("");
}

function renderWelcome() {
  els.messages.innerHTML = `
    <div class="welcome">
      <div class="welcome-hero">
        <span class="avatar avatar-bot">${ICONS.bot}</span>
        <h2>${greeting()}! I'm Nova 👋</h2>
        <p>Your AI assistant for questions, writing, coding, planning and more. Ask me anything, attach a photo or PDF, speak your question, or switch on 🎨 Image mode to create pictures.</p>
      </div>
      <p class="suggest-label">Try asking</p>
      <div class="suggestions">
        ${SUGGESTIONS.map(
          (s, i) => `
          <button type="button" class="suggestion" data-suggestion="${i}"${streaming ? " disabled" : ""}>
            <span class="emoji" aria-hidden="true">${s.emoji}</span>
            <span><strong>${escapeHtml(s.title)}</strong><small>${escapeHtml(s.prompt)}</small></span>
          </button>`,
        ).join("")}
      </div>
    </div>`;
  els.messages.scrollTop = 0;
}

function isLastAssistant(conv, msg) {
  return msg.role === "assistant" && conv.messages.at(-1) === msg;
}

function attachmentsHtml(attachments) {
  return `<div class="msg-attachments">${attachments
    .map((a) =>
      a.kind === "image"
        ? `<button type="button" class="att-thumb" data-action="open-file" data-file-id="${a.id}" title="Open ${escapeHtml(a.name)}">${imgTag(a.id, a.name)}</button>`
        : `<button type="button" class="att-file" data-action="open-file" data-file-id="${a.id}" title="Open ${escapeHtml(a.name)}">${ICONS.file}<span class="att-name">${escapeHtml(a.name)}</span><small>${formatSize(a.size ?? 0)}</small></button>`,
    )
    .join("")}</div>`;
}

function fillMessage(el, msg, conv) {
  const isStreaming = streaming?.msg === msg;
  const body = el.querySelector(".msg-body");
  let html = "";

  if (msg.role === "user") {
    if (msg.mode === "image") html += '<span class="msg-tag">🎨 Image request</span>';
    if (msg.attachments?.length) html += attachmentsHtml(msg.attachments);
    if (editingId === msg.id) {
      html += `<div class="editor">
        <label class="sr-only" for="edit-${msg.id}">Edit message</label>
        <textarea class="edit-input" id="edit-${msg.id}" rows="3" maxlength="${MAX_CHARS}">${escapeHtml(msg.content)}</textarea>
        <div class="editor-actions">
          <button type="button" class="btn btn-ghost" data-action="cancel-edit">Cancel</button>
          <button type="button" class="btn btn-primary" data-action="save-edit">Save &amp; send</button>
        </div>
      </div>`;
      body.innerHTML = html;
      hydrateImages(body);
      const editor = body.querySelector(".edit-input");
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      return;
    }
    if (msg.content) html += `<div class="bubble">${escapeHtml(msg.content)}</div>`;
  } else {
    if (isStreaming && !msg.content && !msg.images?.length) {
      html += `<div class="bubble">${TYPING_HTML}${
        streaming.mode === "image" ? '<span class="typing-label">Creating your image… this can take up to a minute.</span>' : ""
      }</div>`;
    } else if (msg.content) {
      html += `<div class="bubble">${renderMarkdown(msg.content)}</div>`;
    }
    if (msg.images?.length) {
      html += `<div class="gen-images">${msg.images
        .map(
          (img, i) => `
          <figure class="gen-image">
            <button type="button" class="gen-image-open" data-action="open-file" data-file-id="${img.id}" title="Open full size">${imgTag(img.id, `Generated image ${i + 1}`)}</button>
            <figcaption><button type="button" class="msg-action" data-action="download-image" data-file-id="${img.id}">${ICONS.download} Download</button></figcaption>
          </figure>`,
        )
        .join("")}</div>`;
    }
  }

  if (msg.note) html += `<div class="msg-note">${escapeHtml(msg.note)}</div>`;
  if (msg.error) {
    html += `<div class="msg-error" role="alert"><span>⚠️ ${escapeHtml(msg.error)}</span>${
      msg.retryable !== false && isLastAssistant(conv, msg) && !streaming
        ? `<button type="button" class="btn btn-ghost" data-action="retry">${ICONS.retry} Retry</button>`
        : ""
    }</div>`;
  }

  if (!isStreaming) {
    const actions = [];
    if (msg.content) actions.push(`<button type="button" class="msg-action" data-action="copy" title="Copy message">${ICONS.copy} Copy</button>`);
    if (msg.role === "user" && !streaming) {
      actions.push(`<button type="button" class="msg-action" data-action="edit" title="Edit and resend">${ICONS.edit} Edit</button>`);
    }
    if (isLastAssistant(conv, msg) && !msg.error && !streaming) {
      actions.push(`<button type="button" class="msg-action" data-action="regenerate" title="Generate a new answer">${ICONS.retry} Regenerate</button>`);
    }
    html += `<div class="msg-meta"><time datetime="${new Date(msg.ts).toISOString()}">${formatTime(msg.ts)}</time>${
      msg.edited ? '<span class="edited">· edited</span>' : ""
    }${actions.join("")}</div>`;

    if (isLastAssistant(conv, msg) && msg.followUps?.length && !streaming) {
      html += `<div class="follow-ups" aria-label="Suggested follow-up questions">${msg.followUps
        .map((q, i) => `<button type="button" class="follow-up" data-follow-up="${i}">${ICONS.spark}<span>${escapeHtml(q)}</span></button>`)
        .join("")}</div>`;
    }
  }

  body.innerHTML = html;
  hydrateImages(body);

  // Place a blinking cursor at the end of the text while streaming.
  if (isStreaming && msg.content) {
    let target = body.querySelector(".bubble");
    while (target.lastElementChild && !target.lastElementChild.matches(".code, .table-wrap, hr")) {
      target = target.lastElementChild;
    }
    target.insertAdjacentHTML("beforeend", '<span class="cursor" aria-hidden="true"></span>');
  }
}

function messageElement(msg, conv) {
  const el = document.createElement("article");
  const isUser = msg.role === "user";
  el.className = `msg ${isUser ? "msg-user" : "msg-bot"}`;
  el.dataset.id = msg.id;
  el.setAttribute("aria-label", isUser ? "You said" : "Nova said");
  el.innerHTML = `<span class="avatar ${isUser ? "avatar-user" : "avatar-bot"}" aria-hidden="true">${isUser ? "You" : ICONS.bot}</span><div class="msg-body"></div>`;
  fillMessage(el, msg, conv);
  return el;
}

function renderMessages() {
  const conv = activeConversation();
  if (!conv || !conv.messages.length) {
    renderWelcome();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const msg of conv.messages) fragment.append(messageElement(msg, conv));
  els.messages.replaceChildren(fragment);
  scrollToBottom(true);
}

function refreshMessage(conv, msg) {
  if (conv.id !== activeId) return;
  const el = els.messages.querySelector(`[data-id="${msg.id}"]`);
  if (el) fillMessage(el, msg, conv);
}

function renderTray() {
  els.attachTray.hidden = !pending.length;
  els.attachTray.innerHTML = pending
    .map(
      (p) => `
      <div class="tray-item" title="${escapeHtml(p.name)} (${formatSize(p.size)})">
        ${p.kind === "image" ? imgTag(p.id, p.name) : `<span class="tray-icon">${ICONS.file}</span>`}
        <span class="tray-name">${escapeHtml(p.name)}</span>
        <button type="button" class="tray-remove" data-remove="${p.id}" aria-label="Remove ${escapeHtml(p.name)}">✕</button>
      </div>`,
    )
    .join("");
  hydrateImages(els.attachTray);
  updateComposer();
}

function updateComposer() {
  const length = els.input.value.length;
  els.messages.setAttribute("aria-busy", String(Boolean(streaming)));
  els.sendBtn.classList.toggle("stop", Boolean(streaming));
  els.sendBtn.setAttribute("aria-label", streaming ? "Stop generating" : "Send message");
  els.sendBtn.disabled = !streaming && !els.input.value.trim() && !pending.length;
  els.counter.textContent = length > MAX_CHARS * 0.8 ? `${length} / ${MAX_CHARS}` : "";
  els.counter.classList.toggle("warn", length >= MAX_CHARS);
}

function renderAll() {
  renderHistory();
  renderMessages();
  updateComposer();
  refreshStatus();
}

function scrollToBottom(force = false) {
  if (force || stickToBottom) els.messages.scrollTop = els.messages.scrollHeight;
}

// Re-render only the streaming message, at most once per animation frame.
let frameRequested = false;
function scheduleStreamUpdate() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    if (!streaming || streaming.convId !== activeId) return;
    refreshMessage(activeConversation(), streaming.msg);
    scrollToBottom();
  });
}

// ---------- Attachments ----------
function classifyFile(file) {
  const name = file.name || "";
  if (IMAGE_TYPES.has(file.type)) return { kind: "image", mimeType: file.type };
  if (/\.(heic|heif)$/i.test(name)) return { kind: "image", mimeType: name.toLowerCase().endsWith("heif") ? "image/heif" : "image/heic" };
  if (file.type === "application/pdf" || /\.pdf$/i.test(name)) return { kind: "pdf", mimeType: "application/pdf" };
  if (file.type.startsWith("text/") || file.type === "application/json" || TEXT_EXTENSIONS.test(name)) {
    return { kind: "text", mimeType: "text/plain" };
  }
  return null;
}

/** Shrinks big photos before upload so they stay well under the size limits. */
async function downscaleImage(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size < 1_500_000) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  } catch {
    return null;
  }
}

async function readAttachment(file) {
  const type = classifyFile(file);
  if (!type) throw new Error(`"${file.name}" isn't supported. Attach images, PDFs or text files.`);
  const id = uid();
  const name = file.name || (type.kind === "image" ? "pasted-image.png" : "file");

  if (type.kind === "text") {
    if (file.size > MAX_TEXT_CHARS * 4) throw new Error(`"${name}" is too large for a text file.`);
    const text = await file.text();
    if (text.length > MAX_TEXT_CHARS) throw new Error(`"${name}" is too long (max ${MAX_TEXT_CHARS.toLocaleString()} characters).`);
    return { id, kind: "text", name, mimeType: type.mimeType, size: file.size, record: { kind: "text", name, mimeType: type.mimeType, text } };
  }

  let blob = file;
  let mimeType = type.mimeType;
  if (type.kind === "image") {
    const smaller = await downscaleImage(file);
    if (smaller) {
      blob = smaller;
      mimeType = smaller.type;
    }
  }
  if (blob.size > MAX_FILE_BYTES) throw new Error(`"${name}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const data = await blobToBase64(blob);
  return { id, kind: type.kind, name, mimeType, size: blob.size, record: { kind: type.kind, name, mimeType, data } };
}

async function addFiles(fileList) {
  for (const file of Array.from(fileList ?? [])) {
    if (pending.length >= MAX_ATTACHMENTS) {
      showToast(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
      break;
    }
    try {
      const { record, ...item } = await readAttachment(file);
      await saveFile(item.id, record);
      pending.push(item);
      renderTray();
    } catch (err) {
      showToast(err.message);
    }
  }
  els.input.focus();
}

function removePending(id) {
  pending = pending.filter((p) => p.id !== id);
  deleteFiles([id]);
  renderTray();
}

// ---------- Networking ----------
class ChatError extends Error {
  constructor(message, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

/** Reads a Server-Sent Events response body and calls onEvent for each JSON event. */
async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) onEvent(JSON.parse(data));
      }
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
}

async function toRequestAttachment(file) {
  const record = await loadFile(file.id);
  if (!record) return null;
  return record.kind === "text"
    ? { kind: "text", name: record.name, text: record.text }
    : { kind: "inline", name: record.name, mimeType: record.mimeType, data: record.data };
}

/** Builds the messages sent to the server, loading attachment contents from storage. */
async function buildRequestMessages(conv, mode) {
  let usable = conv.messages.filter(
    (m) => !m.error && (m.content.trim() || m.attachments?.length || m.images?.length),
  );
  // Image requests only need the latest prompt (plus a reference image, below).
  if (mode === "image") usable = usable.slice(-1);

  const cutoff = usable.length - ATTACHMENT_HISTORY;
  const out = [];
  for (const [i, m] of usable.entries()) {
    if (m.role === "assistant") {
      const content = m.content.trim() || (m.images?.length ? "[I created the image you asked for.]" : "");
      if (content) out.push({ role: "assistant", content });
      continue;
    }

    const item = { role: "user", content: m.content };
    const files = m.attachments ?? [];
    if (files.length && i >= cutoff) {
      const loaded = [];
      for (const file of files) {
        const attachment = await toRequestAttachment(file);
        if (attachment) loaded.push(attachment);
        else item.content += `\n[The attached file "${file.name}" is no longer available.]`;
      }
      if (loaded.length) item.attachments = loaded;
    } else if (files.length) {
      item.content += `\n[Earlier attachments: ${files.map((f) => f.name).join(", ")}]`;
    }
    item.content = item.content.trim().slice(0, MAX_CHARS);
    if (item.content || item.attachments) out.push(item);
  }

  // In image mode, send the most recent generated image along so prompts like
  // "make it blue" can edit it - unless the user attached their own image.
  const last = out.at(-1);
  if (mode === "image" && last && !last.attachments?.some((a) => a.kind === "inline")) {
    const previous = [...conv.messages].reverse().find((m) => m.role === "assistant" && m.images?.length);
    const reference = previous && (await toRequestAttachment(previous.images.at(-1)));
    if (reference) last.attachments = [...(last.attachments ?? []), { ...reference, name: "previous-image" }];
  }
  return out;
}

async function fetchFollowUps(conv, msg) {
  const history = conv.messages
    .filter((m) => !m.error && m.content.trim())
    .slice(-6)
    .map(({ role, content }) => ({ role, content: content.slice(0, MAX_CHARS) }));
  try {
    const response = await fetch("/api/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    if (!response.ok) return;
    const { suggestions } = await response.json();
    if (!Array.isArray(suggestions) || !suggestions.length) return;
    msg.followUps = suggestions.slice(0, 3).map(String);
    save();
    if (!streaming && isLastAssistant(conv, msg)) {
      refreshMessage(conv, msg);
      scrollToBottom();
    }
  } catch {
    // Suggestions are a nice-to-have; ignore failures.
  }
}

async function generateReply(conv) {
  const lastUser = conv.messages.findLast((m) => m.role === "user");
  const mode = lastUser?.mode === "image" ? "image" : "chat";

  const msg = { id: uid(), role: "assistant", content: "", ts: Date.now() };
  conv.messages.push(msg);
  conv.updatedAt = Date.now();
  streaming = { controller: new AbortController(), convId: conv.id, msg, mode };
  stickToBottom = true;
  save();
  renderAll();

  let finished = null;
  try {
    const history = await buildRequestMessages(conv, mode);
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, mode }),
      signal: streaming.controller.signal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new ChatError(
        data?.error?.message ?? `The server returned an error (${response.status}). Please try again.`,
        data?.error?.retryable ?? response.status >= 500,
      );
    }

    serverHealthy = true;
    await readEvents(response, (event) => {
      if (event.type === "delta") {
        msg.content += event.text;
        scheduleStreamUpdate();
      } else if (event.type === "image") {
        const id = uid();
        const ext = event.mimeType.split("/")[1] ?? "png";
        saveFile(id, { kind: "image", name: `nova-image-${Date.now()}.${ext}`, mimeType: event.mimeType, data: event.data });
        msg.images = [...(msg.images ?? []), { id, mimeType: event.mimeType }];
        scheduleStreamUpdate();
      } else if (event.type === "done") {
        finished = event;
      } else if (event.type === "error") {
        throw new ChatError(event.error?.message ?? "Something went wrong.", event.error?.retryable ?? true);
      }
    });

    if (!finished) throw new ChatError("The connection closed before the reply finished. Please try again.");

    if (finished.stopReason === "refusal") {
      // A declined reply may contain partial output; discard it.
      msg.content = "";
      deleteFiles(fileIdsOfMessage(msg));
      delete msg.images;
      msg.note =
        mode === "image"
          ? "Sorry, I can't create that image. Try describing something else."
          : "Sorry, I can't help with that request. Try rephrasing it or asking something else.";
    } else if (finished.stopReason === "max_tokens") {
      msg.note = "This reply reached the length limit and may be cut off. Ask me to continue.";
    } else if (mode === "image" && !msg.images?.length) {
      msg.note = "No image was created this time. Try describing it in a different way.";
    }

    if (mode === "chat" && msg.content && features.followUps) fetchFollowUps(conv, msg);
  } catch (err) {
    if (err.name === "AbortError") {
      if (msg.content || msg.images?.length) msg.note = "Response stopped.";
      else conv.messages.splice(conv.messages.indexOf(msg), 1);
    } else if (err instanceof ChatError) {
      msg.error = err.message;
      msg.retryable = err.retryable;
    } else {
      // fetch() rejects with a TypeError on network failures.
      serverHealthy = navigator.onLine ? false : serverHealthy;
      msg.error = navigator.onLine
        ? "Couldn't reach the server. Make sure it's running, then try again."
        : "You're offline. Check your internet connection and try again.";
      msg.retryable = true;
      console.error(err);
    }
  } finally {
    streaming = null;
    conv.updatedAt = Date.now();
    save();
    if (conv.id === activeId) renderAll();
    else renderHistory();
    updateComposer();
    refreshStatus();
  }
}

async function sendMessage(rawText, { mode } = {}) {
  const text = rawText.trim();
  if ((!text && !pending.length) || streaming) return;
  if (text.length > MAX_CHARS) {
    showToast(`Messages are limited to ${MAX_CHARS} characters.`);
    return;
  }
  stopListening();
  const sendMode = mode ?? (imageMode ? "image" : "chat");
  const conv = ensureConversation();
  const msg = { id: uid(), role: "user", content: text, ts: Date.now() };
  if (sendMode === "image") msg.mode = "image";
  if (pending.length) msg.attachments = pending;
  conv.messages.push(msg);
  if (conv.title === "New chat") conv.title = makeTitle(text || pending[0].name);

  pending = [];
  renderTray();
  els.input.value = "";
  autosize();
  await generateReply(conv);
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    serverHealthy = true;
    features = { followUps: true, ...data.features };
    showBanner(
      data.apiKeyConfigured
        ? ""
        : "No Gemini API key was found on the server. Add GEMINI_API_KEY to your .env file and restart the server (see README).",
    );
  } catch {
    serverHealthy = false;
    showBanner("Can't reach the chat server. Make sure it's running (npm start), then refresh.", "error");
  }
  refreshStatus();
}

// ---------- Actions ----------
function openConversation(id) {
  if (id === activeId) return closeSidebar();
  activeId = id;
  editingId = null;
  storage.write(ACTIVE_KEY, activeId);
  renderAll();
  closeSidebar();
  els.input.focus();
}

function newChat() {
  editingId = null;
  const current = activeConversation();
  if (current && !current.messages.length) {
    closeSidebar();
    els.input.focus();
    return;
  }
  activeId = null;
  ensureConversation();
  save();
  renderAll();
  closeSidebar();
  els.input.focus();
}

function stopStreaming() {
  streaming?.controller.abort();
}

async function clearChat() {
  const conv = activeConversation();
  if (!conv || !conv.messages.length) {
    showToast("This chat is already empty.");
    return;
  }
  const confirmed = await confirmAction({
    title: "Clear this chat?",
    text: "All messages and files in this conversation will be deleted. This can't be undone.",
    ok: "Clear chat",
  });
  if (!confirmed) return;
  if (streaming?.convId === conv.id) stopStreaming();
  deleteFiles(fileIdsOfConversation(conv));
  conversations = conversations.filter((c) => c.id !== conv.id);
  activeId = null;
  editingId = null;
  ensureConversation();
  save();
  renderAll();
  showToast("Chat cleared");
  els.input.focus();
}

async function deleteConversation(id) {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  const confirmed = await confirmAction({
    title: "Delete this chat?",
    text: `“${conv.title}” will be permanently deleted from this browser.`,
    ok: "Delete",
  });
  if (!confirmed) return;
  if (streaming?.convId === id) stopStreaming();
  deleteFiles(fileIdsOfConversation(conv));
  conversations = conversations.filter((c) => c.id !== id);
  if (activeId === id) {
    activeId = null;
    editingId = null;
    ensureConversation();
  }
  save();
  renderAll();
  showToast("Chat deleted");
}

function retryLast(conv, msg) {
  if (streaming || !isLastAssistant(conv, msg)) return;
  conv.messages.pop();
  deleteFiles(fileIdsOfMessage(msg));
  generateReply(conv);
}

function startEdit(conv, msg) {
  if (streaming) return;
  const previous = editingId && conv.messages.find((m) => m.id === editingId);
  editingId = msg.id;
  if (previous) refreshMessage(conv, previous);
  refreshMessage(conv, msg);
}

function cancelEdit(conv, msg) {
  editingId = null;
  refreshMessage(conv, msg);
}

function saveEdit(conv, msg) {
  const editor = els.messages.querySelector(`[data-id="${msg.id}"] .edit-input`);
  const text = editor?.value.trim() ?? "";
  if (!text && !msg.attachments?.length) {
    showToast("Your message can't be empty.");
    return;
  }
  if (streaming) return;
  editingId = null;
  // Everything after the edited message is replaced by the new answer.
  const removed = conv.messages.splice(conv.messages.indexOf(msg) + 1);
  deleteFiles(removed.flatMap(fileIdsOfMessage));
  if (text !== msg.content) msg.edited = true;
  msg.content = text;
  msg.ts = Date.now();
  generateReply(conv);
}

async function openFile(id) {
  const record = await loadFile(id);
  if (!record) {
    showToast("This file is no longer available.");
    return;
  }
  const url = await fileUrl(id);
  if (url) window.open(url, "_blank", "noopener");
}

async function downloadImage(id) {
  const record = await loadFile(id);
  const url = await fileUrl(id);
  if (!record || !url) {
    showToast("This image is no longer available.");
    return;
  }
  downloadUrl(url, record.name || "nova-image.png");
}

function exportChat() {
  const conv = activeConversation();
  if (!conv?.messages.length) {
    showToast("Nothing to export yet.");
    return;
  }
  const lines = [`# ${conv.title}`, "", `_Exported from Nova on ${new Date().toLocaleString()}_`, ""];
  for (const m of conv.messages) {
    lines.push(`### ${m.role === "user" ? "You" : "Nova"} · ${new Date(m.ts).toLocaleString()}`, "");
    if (m.mode === "image") lines.push("_🎨 Image request_", "");
    if (m.attachments?.length) lines.push(`📎 Attached: ${m.attachments.map((a) => a.name).join(", ")}`, "");
    if (m.content) lines.push(m.content, "");
    if (m.images?.length) lines.push(`_[${m.images.length} generated image(s), download them from the chat]_`, "");
    if (m.note) lines.push(`> ${m.note}`, "");
    if (m.error) lines.push(`> ⚠️ ${m.error}`, "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const slug = conv.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "chat";
  downloadUrl(url, `nova-${slug}.md`);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  showToast("Chat exported");
}

function setImageMode(on) {
  imageMode = on;
  els.imageModeBtn.setAttribute("aria-pressed", String(on));
  els.composerBox.classList.toggle("image-mode", on);
  els.modeChip.hidden = !on;
  els.input.placeholder = on ? "Describe the image you want to create…" : "Ask Nova anything…";
  els.input.focus();
}

function openSidebar() {
  els.sidebar.classList.add("open");
  els.scrim.hidden = false;
  els.menuBtn.setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  els.sidebar.classList.remove("open");
  els.scrim.hidden = true;
  els.menuBtn.setAttribute("aria-expanded", "false");
}

function toggleTheme() {
  const current =
    document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Theme just won't persist.
  }
}

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
  updateComposer();
}

// ---------- Voice input (Web Speech API, where the browser supports it) ----------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;

function updateMic() {
  els.micBtn.setAttribute("aria-pressed", String(listening));
  els.micBtn.classList.toggle("listening", listening);
  els.micBtn.title = listening ? "Stop listening" : "Speak your message";
  els.input.placeholder = listening
    ? "Listening… speak now"
    : imageMode
      ? "Describe the image you want to create…"
      : "Ask Nova anything…";
}

function startListening() {
  recognition = new SpeechRecognition();
  recognition.lang = navigator.language || "en-US";
  recognition.interimResults = true;
  recognition.continuous = true;

  const base = els.input.value;
  const separator = base && !/\s$/.test(base) ? " " : "";
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results, (result) => result[0].transcript).join("");
    els.input.value = (base + separator + transcript).slice(0, MAX_CHARS);
    autosize();
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showToast("Microphone access is blocked. Allow it in your browser's site settings.");
    } else if (event.error === "no-speech") {
      showToast("I didn't hear anything. Try again.");
    } else if (event.error !== "aborted") {
      showToast(`Voice input stopped (${event.error}).`);
    }
  };
  recognition.onend = () => {
    listening = false;
    updateMic();
  };

  try {
    recognition.start();
    listening = true;
    updateMic();
  } catch {
    showToast("Couldn't start voice input.");
  }
}

function stopListening() {
  if (listening) recognition?.stop();
}

if (SpeechRecognition) els.micBtn.hidden = false;

// ---------- Events ----------
els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (streaming) stopStreaming();
  else sendMessage(els.input.value);
});

els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!streaming) sendMessage(els.input.value);
  }
});
els.input.addEventListener("input", autosize);
els.input.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length) {
    event.preventDefault();
    addFiles(files);
  }
});

els.attachBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.attachTray.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (button) removePending(button.dataset.remove);
});

els.imageModeBtn.addEventListener("click", () => setImageMode(!imageMode));
els.modeChipClose.addEventListener("click", () => setImageMode(false));
els.micBtn.addEventListener("click", () => (listening ? stopListening() : startListening()));

// Drag and drop files anywhere on the chat area.
let dragDepth = 0;
const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
els.main.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  els.dropOverlay.hidden = false;
});
els.main.addEventListener("dragover", (event) => {
  if (hasFiles(event)) event.preventDefault();
});
els.main.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropOverlay.hidden = true;
});
els.main.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  addFiles(event.dataTransfer.files);
});

els.messages.addEventListener("scroll", () => {
  const { scrollTop, scrollHeight, clientHeight } = els.messages;
  stickToBottom = scrollHeight - scrollTop - clientHeight < 80;
});

els.messages.addEventListener("click", (event) => {
  const suggestion = event.target.closest("[data-suggestion]");
  if (suggestion) {
    const s = SUGGESTIONS[Number(suggestion.dataset.suggestion)];
    sendMessage(s.prompt, { mode: s.mode });
    return;
  }

  const copyCode = event.target.closest(".copy-code");
  if (copyCode) {
    copyText(copyCode.closest(".code").querySelector("code").textContent);
    return;
  }

  const conv = activeConversation();
  if (!conv) return;
  const msg = conv.messages.find((m) => m.id === event.target.closest(".msg")?.dataset.id);
  if (!msg) return;

  const followUp = event.target.closest("[data-follow-up]");
  if (followUp) {
    sendMessage(msg.followUps[Number(followUp.dataset.followUp)], { mode: "chat" });
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button) return;
  switch (button.dataset.action) {
    case "copy":
      copyText(msg.content);
      break;
    case "retry":
    case "regenerate":
      retryLast(conv, msg);
      break;
    case "edit":
      startEdit(conv, msg);
      break;
    case "cancel-edit":
      cancelEdit(conv, msg);
      break;
    case "save-edit":
      saveEdit(conv, msg);
      break;
    case "open-file":
      openFile(button.dataset.fileId);
      break;
    case "download-image":
      downloadImage(button.dataset.fileId);
      break;
  }
});

els.messages.addEventListener("keydown", (event) => {
  if (!event.target.matches(".edit-input")) return;
  const conv = activeConversation();
  const msg = conv?.messages.find((m) => m.id === event.target.closest(".msg")?.dataset.id);
  if (!msg) return;
  if (event.key === "Escape") cancelEdit(conv, msg);
  else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    saveEdit(conv, msg);
  }
});

els.history.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  const id = button?.closest(".history-item")?.dataset.id;
  if (!id) return;
  if (button.dataset.action === "open") openConversation(id);
  else if (button.dataset.action === "delete") deleteConversation(id);
});

els.search.addEventListener("input", () => {
  searchQuery = els.search.value;
  renderHistory();
});

els.newChatBtn.addEventListener("click", newChat);
els.exportBtn.addEventListener("click", exportChat);
els.clearBtn.addEventListener("click", clearChat);
els.themeBtn.addEventListener("click", toggleTheme);
els.menuBtn.addEventListener("click", () =>
  els.sidebar.classList.contains("open") ? closeSidebar() : openSidebar(),
);
els.scrim.addEventListener("click", closeSidebar);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && els.sidebar.classList.contains("open")) closeSidebar();
});

window.addEventListener("online", () => {
  refreshStatus();
  checkHealth();
});
window.addEventListener("offline", refreshStatus);
window.addEventListener("beforeunload", () => {
  if (streaming?.msg.content) streaming.msg.note = "This reply was interrupted.";
  save();
});

// ---------- Start ----------
if (!activeConversation()) {
  activeId = conversations.find((c) => c.messages.length)?.id ?? null;
  ensureConversation();
}
renderAll();
checkHealth();
els.input.focus();

// Remove stored files that no conversation (or pending attachment) refers to any more.
allFileIds().then((ids) => {
  const referenced = new Set([...conversations.flatMap(fileIdsOfConversation), ...pending.map((p) => p.id)]);
  const orphans = ids.filter((id) => !referenced.has(id));
  if (orphans.length) deleteFiles(orphans);
});
