import { downloadZip } from "client-zip";
import type { MediaItem } from "./api";

export async function downloadAllZip(items: MediaItem[], onProgress?: (done: number, total: number) => void) {
  const ext = (item: MediaItem) => {
    if (item.kind === "photo") return item.mime.includes("png") ? ".png" : item.mime.includes("heic") ? ".heic" : ".jpg";
    if (item.kind === "video") return item.mime.includes("mp4") ? ".mp4" : ".webm";
    return item.mime.includes("mp4") || item.mime.includes("m4a") ? ".m4a" : ".webm";
  };

  let done = 0;
  async function* files(): AsyncGenerator<File> {
    for (const item of items) {
      const res = await fetch(item.url);
      if (!res.ok || !res.body) throw new Error(`Failed to fetch ${item.id}`);
      const blob = await res.blob();
      const name = `${new Date(item.createdAt).toISOString().replace(/[:T]/g, "-").slice(0, 19)}_${item.uploader}_${item.id.slice(0, 8)}${ext(item)}`;
      done += 1;
      onProgress?.(done, items.length);
      yield new File([blob], name, { type: item.mime });
    }
  }

  const zip = downloadZip(files());
  const blobPromise = zip.blob();
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(await blobPromise);
  anchor.download = `album-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 30000);
}

export function downloadItem(item: MediaItem) {
  const ext = item.kind === "photo" ? (item.mime.includes("png") ? ".png" : ".jpg") : item.kind === "video" ? (item.mime.includes("mp4") ? ".mp4" : ".webm") : (item.mime.includes("mp4") ? ".m4a" : ".webm");
  const anchor = document.createElement("a");
  anchor.href = item.url;
  anchor.download = `${item.uploader}-${item.id.slice(0, 8)}${ext}`;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
