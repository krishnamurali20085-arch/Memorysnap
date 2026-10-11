import { uploadBlob } from "./api";
import { getSettings } from "./store";

export type OutboxItem = {
  qid: string;
  albumId: string;
  kind: "photo" | "video" | "audio";
  blob: Blob;
  thumb?: Blob;
  width?: number;
  height?: number;
  durationMs?: number;
  uploaderToken: string;
  uploader: string;
  lat?: number;
  lon?: number;
  place?: string;
  attempts: number;
  createdAt: number;
};

const DB_NAME = "fps-outbox";
const STORE = "queue";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "qid" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(item: OutboxItem): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  pump();
}

export async function outboxCount(albumId?: string): Promise<number> {
  const db = await openDb();
  const items = await new Promise<OutboxItem[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as OutboxItem[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return albumId ? items.filter((i) => i.albumId === albumId).length : items.length;
}

let pumping = false;
const listeners = new Set<() => void>();

export function onOutboxChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn();
}

export function pump() {
  void processQueue();
}

async function processQueue() {
  if (pumping) return;
  pumping = true;
  try {
    if (!getSettings().syncEnabled || !navigator.onLine) return;
    const db = await openDb();
    const items = await new Promise<OutboxItem[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as OutboxItem[]);
      req.onerror = () => reject(req.error);
    });
    items.sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items) {
      if (!getSettings().syncEnabled || !navigator.onLine) break;
      try {
        await uploadBlob(item.albumId, item.kind, item.blob, {
          thumbBlob: item.thumb,
          width: item.width,
          height: item.height,
          durationMs: item.durationMs,
          uploaderToken: item.uploaderToken,
          uploader: item.uploader,
          lat: item.lat,
          lon: item.lon,
          place: item.place,
        });
        const db2 = await openDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db2.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(item.qid);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db2.close();
        notify();
      } catch {
        item.attempts += 1;
        const db3 = await openDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db3.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(item);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db3.close();
        break; // stop the loop; backoff via timers below
      }
    }
    db.close();
  } finally {
    pumping = false;
  }
}

export async function clearOutboxAndCache() {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  const cachesOk = "caches" in window;
  if (cachesOk) {
    for (const key of await caches.keys()) await caches.delete(key);
  }
  notify();
}

window.addEventListener("online", pump);
setInterval(() => {
  if (getSettings().syncEnabled && navigator.onLine) pump();
}, 30000);
