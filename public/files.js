// Attachment and generated-image storage.
// File contents live in IndexedDB (localStorage is far too small for images),
// with an in-memory cache so the app still works for the session if
// IndexedDB is unavailable (e.g. some private-browsing modes).

const DB_NAME = "nova-files";
const STORE = "files";
const memory = new Map(); // id -> { kind, name, mimeType, data?, text? }
const objectUrls = new Map(); // id -> blob: URL

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function withStore(mode, run) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const result = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function saveFile(id, record) {
  memory.set(id, record);
  await withStore("readwrite", (store) => store.put(record, id));
}

export async function loadFile(id) {
  if (memory.has(id)) return memory.get(id);
  const record = await withStore("readonly", (store) => store.get(id));
  if (record) memory.set(id, record);
  return record ?? null;
}

export async function deleteFiles(ids) {
  for (const id of ids) {
    memory.delete(id);
    const url = objectUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(id);
  }
  if (ids.length) await withStore("readwrite", (store) => ids.forEach((id) => store.delete(id)));
}

export async function allFileIds() {
  return (await withStore("readonly", (store) => store.getAllKeys())) ?? [];
}

export function base64ToBlob(data, mimeType) {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

/** Returns an already-created blob: URL for a file, without waiting. */
export function cachedFileUrl(id) {
  return objectUrls.get(id) ?? null;
}

/** Returns a blob: URL for a stored file, or null if it no longer exists. */
export async function fileUrl(id) {
  if (objectUrls.has(id)) return objectUrls.get(id);
  const record = await loadFile(id);
  if (!record) return null;
  const blob =
    record.kind === "text"
      ? new Blob([record.text ?? ""], { type: "text/plain;charset=utf-8" })
      : record.data
        ? base64ToBlob(record.data, record.mimeType)
        : null;
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  objectUrls.set(id, url);
  return url;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
