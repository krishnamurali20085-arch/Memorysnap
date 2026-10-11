import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { checkSession, mintSession, randomCode, randomToken, sha256Hex, signValue, uuid, verifyValue } from "./helpers";

type Env = {
  Bindings: {
    DB: D1Database;
    FILES: R2Bucket;
    ASSETS: Fetcher;
    SESSION_SECRET?: string;
    APP_ORIGIN?: string;
  };
};

// createPresignedUrl is a real runtime API but is not yet in @cloudflare/workers-types
type PresignableBucket = R2Bucket & {
  createPresignedUrl(opts: { method: "GET" | "PUT" | "HEAD"; key: string; expiration: number }): string;
};

const MAX_OBJECT_BYTES = 10 * 1024 * 1024 * 1024; // R2 hard cap per object
const PENDING_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;
const PUT_URL_TTL_S = 3600;
const GET_URL_TTL_S = 7 * 24 * 3600;

const DDL = `
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pin TEXT,
  delete_policy TEXT NOT NULL DEFAULT 'everyone',
  host_token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL REFERENCES albums(id),
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader TEXT NOT NULL,
  uploader_token TEXT,
  r2_key TEXT NOT NULL,
  thumb_key TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  pin_hash TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_album_created ON media(album_id, created_at);
`;

const app = new Hono<Env>();

let ddlDone = false;
async function ensureSchema(db: D1Database) {
  if (ddlDone) return;
  for (const stmt of DDL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
  for (const alter of [
    "ALTER TABLE albums ADD COLUMN host_user_id TEXT",
    "ALTER TABLE users ADD COLUMN username TEXT",
    "ALTER TABLE media ADD COLUMN lat REAL",
    "ALTER TABLE media ADD COLUMN lon REAL",
    "ALTER TABLE media ADD COLUMN place TEXT",
  ]) {
    try {
      await db.prepare(alter).run();
    } catch {
      /* column already exists */
    }
  }
  ddlDone = true;
}

async function getUserByPhone(db: D1Database, phone: string) {
  return db.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first<{
    id: string;
    phone: string;
    pin_hash: string;
    display_name: string | null;
    username: string | null;
    created_at: number;
  }>();
}

async function hostAlbums(db: D1Database, userId: string) {
  return db
    .prepare("SELECT id, code, name, delete_policy, host_token, pin, created_at FROM albums WHERE host_user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<{ id: string; code: string; name: string; delete_policy: string; host_token: string; pin: string | null; created_at: number }>();
}

function userCookieValue(secret: string, userId: string): Promise<string> {
  return signValue(secret, `user.${userId}`);
}

async function currentUser(c: any, env: Env["Bindings"]) {
  const raw = getCookie(c, "usr");
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const userId = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!(await verifyValue(secretOf(env), `user.${userId}`, sig))) return null;
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<{
    id: string;
    phone: string;
    pin_hash: string;
    display_name: string | null;
    username: string | null;
    created_at: number;
  }>();
}

// Simple in-isolate login throttling: 5 wrong attempts per phone per 10 minutes.
const loginAttempts = new Map<string, { count: number; until: number }>();
function throttled(key: string): boolean {
  const entry = loginAttempts.get(key);
  return !!entry && entry.count >= 5 && entry.until > Date.now();
}
function recordFailure(key: string) {
  const entry = loginAttempts.get(key);
  if (!entry || entry.until < Date.now()) loginAttempts.set(key, { count: 1, until: Date.now() + 10 * 60 * 1000 });
  else entry.count += 1;
}
function clearFailures(key: string) {
  loginAttempts.delete(key);
}

function secretOf(env: Env["Bindings"]): string {
  return env.SESSION_SECRET || "insecure-dev-secret";
}

function jsonError(c: any, status: number, message: string) {
  return c.json({ error: message }, status);
}

function checkOrigin(c: any, env: Env["Bindings"]): boolean {
  const origin = c.req.header("Origin");
  if (!origin) return true; // non-browser client
  if (env.APP_ORIGIN && origin === env.APP_ORIGIN) return true;
  const host = c.req.header("Host");
  return !!host && origin === `https://${host}` || origin === `http://${host}`;
}

function presignPut(env: Env["Bindings"], key: string, mediaId: string, thumb = false): string {
  const bucket = env.FILES as PresignableBucket;
  if (typeof bucket.createPresignedUrl === "function") {
    return bucket.createPresignedUrl({ method: "PUT", key, expiration: PUT_URL_TTL_S });
  }
  // Local/dev fallback (Miniflare R2 has no presigned URLs): stream through the worker.
  return `/api/upload/${mediaId}${thumb ? "?thumb=1" : ""}`;
}

function presignGet(env: Env["Bindings"], key: string, mediaId: string, thumb = false): string {
  const bucket = env.FILES as PresignableBucket;
  if (typeof bucket.createPresignedUrl === "function") {
    return bucket.createPresignedUrl({ method: "GET", key, expiration: GET_URL_TTL_S });
  }
  return `/api/file/${mediaId}${thumb ? "?thumb=1" : ""}`;
}

type MediaRow = {
  id: string;
  album_id: string;
  kind: string;
  mime: string;
  size: number;
  uploader: string;
  uploader_token: string | null;
  r2_key: string;
  thumb_key: string | null;
  state: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  created_at: number;
  lat: number | null;
  lon: number | null;
  place: string | null;
};

function toItem(env: Env["Bindings"], row: MediaRow) {
  return {
    id: row.id,
    albumId: row.album_id,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    uploader: row.uploader,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    lat: row.lat,
    lon: row.lon,
    place: row.place,
    url: presignGet(env, row.r2_key, row.id),
    thumbUrl: row.thumb_key ? presignGet(env, row.thumb_key, row.id, true) : null,
  };
}

async function requireAlbum(c: any, env: Env["Bindings"], albumId: string) {
  const album = await env.DB.prepare("SELECT * FROM albums WHERE id = ?")
    .bind(albumId)
    .first<{ id: string; code: string; name: string; pin: string | null; delete_policy: string; host_token: string; created_at: number }>();
  if (!album) return { album: null, deviceId: null, isHost: false };
  const deviceId = await checkSession(secretOf(env), albumId, getCookie(c, `as_${albumId}`));
  const isHost = c.req.header("X-Host-Token") === album.host_token;
  return { album, deviceId, isHost };
}

// ---------- Auth (phone + PIN, no SMS in v1) ----------

app.post("/api/auth/login", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  if (!checkOrigin(c, env)) return jsonError(c, 403, "Forbidden origin");
  let body: { phone?: string; pin?: string; name?: string; username?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON");
  }
  const phone = (body.phone || "").replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15) return jsonError(c, 400, "Enter a valid phone number");
  const pin = (body.pin || "").replace(/\D/g, "");
  if (pin.length < 4 || pin.length > 8) return jsonError(c, 400, "PIN must be 4-8 digits");
  const username = (body.username || "").trim().replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 24);
  if (username && username.length < 3) return jsonError(c, 400, "Username must be 3-24 letters/numbers");
  const throttleKey = `${phone}:${c.req.header("CF-Connecting-IP") || "local"}`;
  if (throttled(throttleKey)) return jsonError(c, 429, "Too many attempts — try again in 10 minutes");

  const pinHash = await sha256Hex(`${phone}:${pin}`);
  let user = await getUserByPhone(env.DB, phone);
  if (!user) {
    if (!username) return jsonError(c, 400, "Pick a username for your first login");
    const id = uuid();
    const name = (body.name || "").trim().slice(0, 40) || null;
    await env.DB.prepare("INSERT INTO users (id, phone, pin_hash, display_name, username, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, phone, pinHash, name, username, Date.now())
      .run();
    user = { id, phone, pin_hash: pinHash, display_name: name, username, created_at: Date.now() };
  } else if (user.pin_hash !== pinHash) {
    recordFailure(throttleKey);
    return jsonError(c, 401, "Wrong phone or PIN");
  } else if (username && username !== user.username) {
    await env.DB.prepare("UPDATE users SET username = ? WHERE id = ?").bind(username, user.id).run();
    user.username = username;
  }
  clearFailures(throttleKey);

  const sig = await userCookieValue(secretOf(env), user.id);
  setCookie(c, "usr", `${user.id}.${sig}`, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
    maxAge: 60 * 60 * 24 * 399, // cookie cap: 400 days max
  });
  const albums = await hostAlbums(env.DB, user.id);
  return c.json({
    userId: user.id,
    phone: user.phone,
    username: user.username,
    displayName: user.display_name,
    albums: albums.results.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      deletePolicy: a.delete_policy,
      hostToken: a.host_token,
      hasPin: !!a.pin,
      createdAt: a.created_at,
    })),
  });
});

app.get("/api/me", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  const user = await currentUser(c, env);
  if (!user) return jsonError(c, 401, "Not logged in");
  return c.json({ userId: user.id, phone: user.phone, username: user.username, displayName: user.display_name });
});

app.post("/api/auth/logout", (c) => {
  setCookie(c, "usr", "", { path: "/", httpOnly: true, maxAge: 0 });
  return c.json({ ok: true });
});

app.get("/api/me/albums", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  const user = await currentUser(c, env);
  if (!user) return jsonError(c, 401, "Not logged in");
  const albums = await hostAlbums(env.DB, user.id);
  return c.json({
    albums: albums.results.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      deletePolicy: a.delete_policy,
      hostToken: a.host_token,
      hasPin: !!a.pin,
      createdAt: a.created_at,
    })),
  });
});

// ---------- Albums ----------

app.post("/api/albums", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  if (!checkOrigin(c, env)) return jsonError(c, 403, "Forbidden origin");
  const hostUser = await currentUser(c, env);
  if (!hostUser) return jsonError(c, 401, "Log in with your phone number to create an album");
  let body: { name?: string; pin?: string; deletePolicy?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON");
  }
  const name = (body.name || "").trim().slice(0, 60);
  if (!name) return jsonError(c, 400, "Album name required");
  const policy = ["everyone", "host", "uploader"].includes(body.deletePolicy || "")
    ? (body.deletePolicy as string)
    : "everyone";
  const pin = body.pin && /^\d{4,8}$/.test(body.pin) ? body.pin : null;

  const hostToken = randomToken(24);
  const id = uuid();
  let code = randomCode();
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await env.DB.prepare(
        "INSERT INTO albums (id, code, name, pin, delete_policy, host_token, host_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(id, code, name, pin ? await sha256Hex(pin) : null, policy, hostToken, hostUser.id, Date.now())
        .run();
      break;
    } catch (e: any) {
      if (String(e?.message || e).includes("UNIQUE") && attempt < 5) {
        code = randomCode();
        continue;
      }
      throw e;
    }
  }
  setCookie(c, `as_${id}`, await mintSession(secretOf(env), id, "host"), {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
    maxAge: 60 * 60 * 24 * 399, // cookie cap: 400 days max
  });
  return c.json({ albumId: id, code, hostToken, name, deletePolicy: policy, hasPin: !!pin });
});

app.post("/api/albums/join", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  if (!checkOrigin(c, env)) return jsonError(c, 403, "Forbidden origin");
  let body: { code?: string; pin?: string; deviceId?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON");
  }
  const code = (body.code || "").replace(/\D/g, "");
  if (!code) return jsonError(c, 400, "Code required");
  const album = await env.DB.prepare("SELECT * FROM albums WHERE code = ?")
    .bind(code)
    .first<{ id: string; name: string; pin: string | null; delete_policy: string; host_token: string }>();
  if (!album) return jsonError(c, 404, "No album with that code");
  if (album.pin) {
    if (!body.pin) return jsonError(c, 401, "PIN required");
    if ((await sha256Hex(body.pin)) !== album.pin) return jsonError(c, 401, "Wrong PIN");
  }
  const deviceId = body.deviceId && /^[a-f0-9]{16,64}$/.test(body.deviceId) ? body.deviceId : randomToken(16);
  setCookie(c, `as_${album.id}`, await mintSession(secretOf(env), album.id, deviceId), {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
    maxAge: 60 * 60 * 24 * 399, // cookie cap: 400 days max
  });
  return c.json({
    albumId: album.id,
    name: album.name,
    deletePolicy: album.delete_policy,
    hasPin: true,
    deviceId,
  });
});

app.get("/api/albums/:id/meta", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  const { album, isHost } = await requireAlbum(c, env, c.req.param("id"));
  if (!album) return jsonError(c, 404, "Album not found");
  if (!isHost && !getCookie(c, `as_${album.id}`)) return jsonError(c, 401, "Join the album first");
  const counts = await env.DB.prepare(
    "SELECT kind, COUNT(*) AS n FROM media WHERE album_id = ? AND state = 'ready' GROUP BY kind",
  )
    .bind(album.id)
    .all<{ kind: string; n: number }>();
  const photoCount = counts.results.find((r) => r.kind === "photo")?.n ?? 0;
  const videoCount = counts.results.find((r) => r.kind === "video")?.n ?? 0;
  const audioCount = counts.results.find((r) => r.kind === "audio")?.n ?? 0;
  return c.json({
    id: album.id,
    code: album.code,
    name: album.name,
    deletePolicy: album.delete_policy,
    hasPin: !!album.pin,
    createdAt: album.created_at,
    isHost,
    counts: { photo: photoCount, video: videoCount, audio: audioCount },
  });
});

app.get("/api/albums/:id/feed", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  const { album, isHost } = await requireAlbum(c, env, c.req.param("id"));
  if (!album) return jsonError(c, 404, "Album not found");
  if (!isHost && !getCookie(c, `as_${album.id}`)) return jsonError(c, 401, "Join the album first");
  const since = Number(c.req.query("since") || 0);
  const limit = Math.min(Number(c.req.query("limit") || 100), 200);
  const rows = await env.DB.prepare(
    "SELECT * FROM media WHERE album_id = ? AND state = 'ready' AND created_at > ? ORDER BY created_at ASC LIMIT ?",
  )
    .bind(album.id, Number.isFinite(since) ? since : 0, limit)
    .all<MediaRow>();
  // lazy sweep of stale pending rows, fire and forget
  env.DB.prepare("DELETE FROM media WHERE album_id = ? AND state = 'pending' AND created_at < ?")
    .bind(album.id, Date.now() - PENDING_SWEEP_AGE_MS)
    .run()
    .catch(() => {});
  const items = rows.results.map((r) => toItem(env, r));
  const nextCursor = items.length ? items[items.length - 1].createdAt : (Number.isFinite(since) ? since : 0);
  return c.json({ items, nextCursor });
});

// ---------- Media ----------

app.post("/api/albums/:id/media", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  if (!checkOrigin(c, env)) return jsonError(c, 403, "Forbidden origin");
  const { album } = await requireAlbum(c, env, c.req.param("id"));
  if (!album) return jsonError(c, 404, "Album not found");
  if (!getCookie(c, `as_${album.id}`) && c.req.header("X-Host-Token") !== album.host_token) {
    return jsonError(c, 401, "Join the album first");
  }
  let body: {
    kind?: string;
    mime?: string;
    size?: number;
    uploader?: string;
    uploaderToken?: string;
    thumbSize?: number;
    width?: number;
    height?: number;
    durationMs?: number;
    lat?: number;
    lon?: number;
    place?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON");
  }
  const kind = body.kind;
  if (!["photo", "video", "audio"].includes(kind || "")) return jsonError(c, 400, "Bad kind");
  const mime = String(body.mime || "").slice(0, 100);
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) return jsonError(c, 400, "Bad size");
  if (size > MAX_OBJECT_BYTES) return jsonError(c, 413, "File exceeds the 10 GB per-object storage limit");
  const thumbSize = Number(body.thumbSize || 0);
  if (thumbSize > 5 * 1024 * 1024) return jsonError(c, 413, "Thumbnail too large");

  const id = uuid();
  const r2Key = `albums/${album.id}/${id}`;
  const thumbKey = thumbSize > 0 ? `${r2Key}.thumb` : null;
  const uploader = (body.uploader || "Guest").trim().slice(0, 40) || "Guest";
  const uploaderToken = body.uploaderToken && /^[a-f0-9]{16,64}$/.test(body.uploaderToken) ? body.uploaderToken : null;

  await env.DB.prepare(    `INSERT INTO media (id, album_id, kind, mime, size, uploader, uploader_token, r2_key, thumb_key, state, width, height, duration_ms, lat, lon, place, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      album.id,
      kind,
      mime,
      size,
      uploader,
      uploaderToken,
      r2Key,
      thumbKey,
      body.width ?? null,
      body.height ?? null,
      body.durationMs ?? null,
      Number.isFinite(body.lat) ? (body.lat as number) : null,
      Number.isFinite(body.lon) ? (body.lon as number) : null,
      (body.place || "").trim().slice(0, 120) || null,
      Date.now(),
    )
    .run();

  return c.json({
    mediaId: id,
    uploadUrl: presignPut(env, r2Key, id),
    thumbUploadUrl: thumbKey ? presignPut(env, thumbKey, id, true) : null,
  });
});

// Chunked upload protocol: files above PART_THRESHOLD_BYTES are split client-side
// and assembled with R2 multipart uploads, lifting any per-request size limit
// (the only cap left is R2's 10 GB per-object limit).
const PART_THRESHOLD_BYTES = 24 * 1024 * 1024;
const MAX_PARTS = 1000;

app.post("/api/media/:id/parts", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  if (!checkOrigin(c, env)) return jsonError(c, 403, "Forbidden origin");
  const row = await loadMedia(env, c.req.param("id"));
  if (!row) return jsonError(c, 404, "Not found");
  if (row.state === "ready") return jsonError(c, 409, "Already uploaded");
  let body: { partCount?: number };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON");
  }
  const partCount = Number(body.partCount);
  if (!Number.isInteger(partCount) || partCount < 1 || partCount > MAX_PARTS) {
    return jsonError(c, 400, "Bad part count");
  }
  const mp = await env.FILES.createMultipartUpload(row.r2_key, {
    httpMetadata: { contentType: row.mime || undefined },
  });
  return c.json({
    uploadId: mp.uploadId,
    partCount,
    partUrls: Array.from({ length: partCount }, (_, i) => `/api/upload/${row.id}?part=${i + 1}&uploadId=${mp.uploadId}`),
  });
});

// Single-shot upload (small files/thumbs) and chunk upload (part + uploadId).
app.put("/api/upload/:id", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  if (!checkOrigin(c, env)) return jsonError(c, 403, "Forbidden origin");
  const row = await loadMedia(env, c.req.param("id"));
  if (!row) return jsonError(c, 404, "Not found");

  const partParam = c.req.query("part");
  const uploadId = c.req.query("uploadId");
  if (partParam || uploadId) {
    const partNumber = Number(partParam);
    if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
      return jsonError(c, 400, "Bad chunk parameters");
    }
    const buf = await c.req.raw.arrayBuffer();
    if (!buf.byteLength) return jsonError(c, 400, "Empty chunk");
    if (buf.byteLength > PART_THRESHOLD_BYTES + 1024 * 1024) return jsonError(c, 413, "Chunk too large");
    const mp = env.FILES.resumeMultipartUpload(row.r2_key, uploadId);
    try {
      const uploaded = await mp.uploadPart(partNumber, buf);
      return c.json({ partNumber, etag: uploaded.etag });
    } catch (e) {
      return jsonError(c, 500, `Chunk store failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  const thumb = c.req.query("thumb") === "1";
  if (thumb && !row.thumb_key) return jsonError(c, 404, "No thumbnail slot");
  const key = thumb ? row.thumb_key! : row.r2_key;
  const body = c.req.raw.body;
  if (!body) return jsonError(c, 400, "Empty body");
  await env.FILES.put(key, body, {
    httpMetadata: { contentType: c.req.header("Content-Type") || undefined },
  });
  return c.json({ ok: true });
});

app.post("/api/media/:id/parts/complete", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  if (!checkOrigin(c, env)) return jsonError(c, 403, "Forbidden origin");
  const row = await loadMedia(env, c.req.param("id"));
  if (!row) return jsonError(c, 404, "Not found");
  let body: { uploadId?: string; parts?: { partNumber: number; etag: string }[] };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON");
  }
  if (!body.uploadId || !Array.isArray(body.parts) || body.parts.length < 1 || body.parts.length > MAX_PARTS) {
    return jsonError(c, 400, "Bad completion payload");
  }
  const mp = env.FILES.resumeMultipartUpload(row.r2_key, body.uploadId);
  try {
    await mp.complete(body.parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })));
  } catch (e) {
    return jsonError(c, 500, `Assembly failed: ${e instanceof Error ? e.message : "unknown"}`);
  }
  const head = await env.FILES.head(row.r2_key);
  const size = head?.size ?? row.size;
  await env.DB.prepare("UPDATE media SET state = 'ready', size = ? WHERE id = ?").bind(size, row.id).run();
  row.state = "ready";
  row.size = size;
  return c.json({ item: toItem(env, row) });
});

// Proxied download fallback for environments without R2 presigned URLs (local dev).
app.get("/api/file/:id", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  const row = await loadMedia(env, c.req.param("id"));
  if (!row || row.state !== "ready") return jsonError(c, 404, "Not found");
  const thumb = c.req.query("thumb") === "1";
  if (thumb && !row.thumb_key) return jsonError(c, 404, "No thumbnail");
  const key = thumb ? row.thumb_key! : row.r2_key;
  const obj = await env.FILES.get(key);
  if (!obj) return jsonError(c, 404, "Not found in storage");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!thumb && row.mime) headers.set("Content-Type", row.mime);
  headers.set("Content-Length", String(obj.size));
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(obj.body, { headers });
});

async function loadMedia(env: Env["Bindings"], mediaId: string) {
  return env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(mediaId).first<MediaRow>();
}

app.post("/api/media/:id/complete", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  if (!checkOrigin(c, env)) return jsonError(c, 403, "Forbidden origin");
  const row = await loadMedia(env, c.req.param("id"));
  if (!row) return jsonError(c, 404, "Not found");
  const head = await env.FILES.head(row.r2_key);
  if (!head) return jsonError(c, 409, "Upload not found in storage yet");
  if (row.state !== "ready") {
    await env.DB.prepare("UPDATE media SET state = 'ready', size = ? WHERE id = ?").bind(head.size, row.id).run();
    row.state = "ready";
    row.size = head.size;
  }
  return c.json({ item: toItem(env, row) });
});

app.get("/api/media/:id/url", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  const row = await loadMedia(env, c.req.param("id"));
  if (!row || row.state !== "ready") return jsonError(c, 404, "Not found");
  return c.json({ url: presignGet(env, row.r2_key, row.id), mime: row.mime, kind: row.kind });
});

app.delete("/api/media/:id", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  if (!checkOrigin(c, env)) return jsonError(c, 403, "Forbidden origin");
  const row = await loadMedia(env, c.req.param("id"));
  if (!row || row.state !== "ready") return jsonError(c, 404, "Not found");
  const { album, isHost } = await requireAlbum(c, env, row.album_id);
  if (!album) return jsonError(c, 404, "Album not found");
  const isUploader = !!row.uploader_token && row.uploader_token === c.req.header("X-Uploader-Token");
  let allowed = false;
  if (album.delete_policy === "everyone") allowed = isHost || !!getCookie(c, `as_${row.album_id}`);
  else if (album.delete_policy === "host") allowed = isHost;
  else if (album.delete_policy === "uploader") allowed = isHost || isUploader;
  if (!allowed) return jsonError(c, 403, "Deletion not permitted by album policy");
  await env.FILES.delete([row.r2_key, ...(row.thumb_key ? [row.thumb_key] : [])]);
  await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(row.id).run();
  return c.json({ ok: true });
});

app.delete("/api/albums/:id", async (c) => {
  const env = c.env;
  await ensureSchema(env.DB);
  if (!checkOrigin(c, env)) return jsonError(c, 403, "Forbidden origin");
  const user = await currentUser(c, env);
  if (!user) return jsonError(c, 401, "Not logged in");
  const albumId = c.req.param("id");
  const album = await env.DB.prepare("SELECT id, host_user_id FROM albums WHERE id = ?").bind(albumId).first<{ id: string; host_user_id: string | null }>();
  if (!album) return jsonError(c, 404, "Album not found");
  if (album.host_user_id !== user.id) return jsonError(c, 403, "Only the album host can delete it");
  const rows = await env.DB.prepare("SELECT r2_key, thumb_key FROM media WHERE album_id = ?").bind(albumId).all<{ r2_key: string; thumb_key: string | null }>();
  const keys: string[] = [];
  for (const r of rows.results) {
    keys.push(r.r2_key);
    if (r.thumb_key) keys.push(r.thumb_key);
  }
  for (let i = 0; i < keys.length; i += 100) {
    await env.FILES.delete(keys.slice(i, i + 100));
  }
  await env.DB.prepare("DELETE FROM media WHERE album_id = ?").bind(albumId).run();
  await env.DB.prepare("DELETE FROM albums WHERE id = ?").bind(albumId).run();
  return c.json({ ok: true, removedMedia: rows.results.length });
});

app.get("/api/health", (c) => c.json({ ok: true }));

// ---------- SPA fallback ----------

app.notFound(async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api/")) return jsonError(c, 404, "Not found");
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status !== 404) return asset;
  const index = await c.env.ASSETS.fetch(new Request(new URL("/", url.origin), { headers: c.req.header() }));
  return index;
});

export default app;
