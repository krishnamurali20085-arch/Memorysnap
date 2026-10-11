import { getAlbum } from "./store";

export type MediaItem = {
  id: string;
  albumId: string;
  kind: "photo" | "video" | "audio";
  mime: string;
  size: number;
  uploader: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  createdAt: number;
  lat: number | null;
  lon: number | null;
  place: string | null;
  url: string;
  thumbUrl: string | null;
};

export type HostAlbum = {
  id: string;
  code: string;
  name: string;
  deletePolicy: "everyone" | "host" | "uploader";
  hostToken: string;
  hasPin: boolean;
  createdAt: number;
};

export type UserSession = {
  userId: string;
  phone: string;
  username: string | null;
  displayName: string | null;
  albums: HostAlbum[];
};

export type AlbumMeta = {
  id: string;
  code: string;
  name: string;
  deletePolicy: "everyone" | "host" | "uploader";
  hasPin: boolean;
  createdAt: number;
  isHost: boolean;
  counts: { photo: number; video: number; audio: number };
};

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(path),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* keep default */
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function authHeaders(path: string): Record<string, string> {
  const albumMatch = path.match(/\/api\/albums\/([0-9a-f-]+)/);
  const mediaMatch = path.match(/\/api\/media\/([0-9a-f-]+)/);
  const headers: Record<string, string> = {};
  const albumId = albumMatch?.[1] ?? null;
  if (albumId) {
    const entry = getAlbum(albumId);
    if (entry?.hostToken) headers["X-Host-Token"] = entry.hostToken;
    if (entry?.uploaderToken) headers["X-Uploader-Token"] = entry.uploaderToken;
  } else if (mediaMatch) {
    for (const entry of Object.values(getAlbumMap())) {
      if (entry.uploaderToken) headers["X-Uploader-Token"] = entry.uploaderToken;
    }
  }
  return headers;
}

function getAlbumMap() {
  try {
    return JSON.parse(localStorage.getItem("fps:albums") || "{}") as Record<
      string,
      { uploaderToken: string; hostToken?: string }
    >;
  } catch {
    return {};
  }
}

export const api = {
  createAlbum: (name: string, pin: string | null, deletePolicy: string) =>
    req<{ albumId: string; code: string; hostToken: string; name: string; deletePolicy: string }>("/api/albums", {
      method: "POST",
      body: JSON.stringify({ name, pin, deletePolicy }),
    }),

  joinAlbum: (code: string, pin: string | null, deviceId: string) =>
    req<{ albumId: string; name: string; deletePolicy: string; deviceId: string }>("/api/albums/join", {
      method: "POST",
      body: JSON.stringify({ code, pin, deviceId }),
    }),

  meta: (albumId: string) => req<AlbumMeta>(`/api/albums/${albumId}/meta`),

  feed: (albumId: string, since = 0, limit = 100) =>
    req<{ items: MediaItem[]; nextCursor: number }>(`/api/albums/${albumId}/feed?since=${since}&limit=${limit}`),

  presign: (
    albumId: string,
    info: {
      kind: string;
      mime: string;
      size: number;
      uploader: string;
      uploaderToken: string;
      thumbSize?: number;
      width?: number;
      height?: number;
      durationMs?: number;
      lat?: number;
      lon?: number;
      place?: string;
    },
  ) =>
    req<{ mediaId: string; uploadUrl: string; thumbUploadUrl: string | null }>(`/api/albums/${albumId}/media`, {
      method: "POST",
      body: JSON.stringify(info),
    }),

  complete: (mediaId: string) => req<{ item: MediaItem }>(`/api/media/${mediaId}/complete`, { method: "POST" }),

  startUpload: (mediaId: string, partCount: number) =>
    req<{ uploadId: string; partCount: number; partUrls: string[] }>(`/api/media/${mediaId}/parts`, {
      method: "POST",
      body: JSON.stringify({ partCount }),
    }),

  finishUpload: (mediaId: string, payload: { uploadId: string; parts: { partNumber: number; etag: string }[] }) =>
    req<{ item: MediaItem }>(`/api/media/${mediaId}/parts/complete`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  login: (phone: string, pin: string, username?: string, name?: string) =>
    req<UserSession>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone, pin, username, name }),
    }),

  me: () => req<{ userId: string; phone: string; username: string | null; displayName: string | null }>("/api/me"),

  logout: () => req<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  myAlbums: () => req<{ albums: HostAlbum[] }>("/api/me/albums"),

  deleteAlbum: (albumId: string) =>
    req<{ ok: boolean; removedMedia: number }>(`/api/albums/${albumId}`, {
      method: "DELETE",
      headers: { "X-Host-Token": getAlbum(albumId)?.hostToken || "" },
    }),

  deleteMedia: (albumId: string, mediaId: string) =>
    req<{ ok: boolean }>(`/api/media/${mediaId}`, {
      method: "DELETE",
      headers: { "X-Host-Token": getAlbum(albumId)?.hostToken || "", "X-Uploader-Token": getAlbum(albumId)?.uploaderToken || "" },
    }),
};

// Files above this size are uploaded in ~24 MB chunks and assembled in storage
// with R2 multipart uploads — no app-imposed size limit (storage caps at 10 GB/file).
export const CHUNK_BYTES = 24 * 1024 * 1024;
const CHUNK_CONCURRENCY = 3;

export async function uploadBlob(
  albumId: string,
  kind: "photo" | "video" | "audio",
  file: Blob,
  extra: {
    thumbBlob?: Blob;
    width?: number;
    height?: number;
    durationMs?: number;
    uploaderToken: string;
    uploader: string;
    lat?: number;
    lon?: number;
    place?: string;
  },
): Promise<MediaItem> {
  const { mediaId, uploadUrl, thumbUploadUrl } = await api.presign(albumId, {
    kind,
    mime: file.type || "application/octet-stream",
    size: file.size,
    uploader: extra.uploader,
    uploaderToken: extra.uploaderToken,
    thumbSize: extra.thumbBlob?.size,
    width: extra.width,
    height: extra.height,
    durationMs: extra.durationMs,
    lat: extra.lat,
    lon: extra.lon,
    place: extra.place,
  });

  if (file.size > CHUNK_BYTES) {
    const partCount = Math.ceil(file.size / CHUNK_BYTES);
    const { uploadId, partUrls } = await api.startUpload(mediaId, partCount);
    const parts: { partNumber: number; etag: string }[] = [];
    let next = 0;
    async function uploadWorker() {
      while (next < partCount) {
        const i = next++;
        const chunk = file.slice(i * CHUNK_BYTES, Math.min(file.size, (i + 1) * CHUNK_BYTES));
        const res = await fetch(partUrls[i], { method: "PUT", body: chunk });
        if (!res.ok) throw new ApiError(`Chunk ${i + 1}/${partCount} failed (${res.status})`, res.status);
        const { etag } = (await res.json()) as { etag: string };
        parts[i] = { partNumber: i + 1, etag };
      }
    }
    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, partCount) }, uploadWorker));
    if (thumbUploadUrl && extra.thumbBlob) {
      const putThumb = await fetch(thumbUploadUrl, { method: "PUT", body: extra.thumbBlob });
      if (!putThumb.ok) throw new ApiError(`Thumbnail upload failed (${putThumb.status})`, putThumb.status);
    }
    const { item } = await api.finishUpload(mediaId, { uploadId, parts });
    return item;
  }

  const put = await fetch(uploadUrl, { method: "PUT", body: file });
  if (!put.ok) throw new ApiError(`Storage upload failed (${put.status})`, put.status);
  if (thumbUploadUrl && extra.thumbBlob) {
    const putThumb = await fetch(thumbUploadUrl, { method: "PUT", body: extra.thumbBlob });
    if (!putThumb.ok) throw new ApiError(`Thumbnail upload failed (${putThumb.status})`, putThumb.status);
  }
  const { item } = await api.complete(mediaId);
  return item;
}
