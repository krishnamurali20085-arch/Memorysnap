# Forever Party Album — Design Spec

Date: 2026-10-11
Status: Approved in chat (design + media amendment)

## 1. Goal

A mobile-first PWA inspired by PartySnap, with one defining difference: **albums never expire**. Guests join with a 6-digit code (no accounts), shoot and share photos/videos/audio live, and any item can be downloaded individually (from the feed card or the full-screen detail view) or as a batch zip.

## 2. Scope (v1)

In scope:
- Permanent albums: create → 6-digit invite code; join → code + optional PIN.
- Live shared feed (3s polling): photos, videos, audio.
- Camera capture: photo, video recording, audio recording.
- Sound-activated auto shutter (Web Audio RMS vs dB sensitivity slider), screen flash on capture.
- Free-hand manual camera: fullscreen viewfinder, shutter button that follows phone tilt (DeviceOrientation), flash modes Auto/On/Off.
- Uploads of existing files (video/audio/photo) with **no app-imposed size limit** (direct-to-R2 presigned PUT; only cap is R2's 10 GB/object and device storage).
- Deletion permissions per album: Everyone / Host only / Uploader only (enforced server-side).
- Download: per-item download button on cards and in detail view; "Download all" as client-side streamed zip.
- Settings (localStorage): font size (5 levels), default sound sensitivity, screen flash toggle, real-time sync toggle (pauses upload outbox), clear local cache.
- Offline outbox (IndexedDB): captures taken offline upload when back online (photos; videos retry too).
- User Guide screen (content adapted from the reference screenshots).
- PWA installable (manifest + service worker).

Out of scope (v1):
- AI best-shot scoring and mood filters (excluded by user choice).
- News tab.
- Accounts / login of any kind.
- Album expiration of any kind — intentionally absent.

## 2b. Accounts & recovery (added after design approval, 2026-10-11)

- **Phone + PIN login, no SMS (v1).** `POST /api/auth/login` {phone, pin, name?}: registers on first use, verifies PIN (SHA-256 of `phone:pin`) after. Normalized digits phone (7-15). In-isolate throttle: 5 wrong attempts per phone+IP per 10 min → 429. Sets `usr` HMAC cookie (400 days).
- **Hosts only.** Creating an album requires a logged-in user; guests still join with code+PIN only. `albums.host_user_id` links albums to their owner.
- **Recovery:** `GET /api/me/albums` returns every album the user hosts incl. `host_token`; the client merges them into localStorage on app load and after login, so uninstalling or switching phones and logging back in restores all hosted albums with full host powers.
- Known trade-off (accepted): without SMS, the number itself is unverified; possession of phone+PIN = account.

## 3. Architecture

Single Cloudflare Worker (Hono, ESM) serving:
- `/api/*` JSON + binary endpoints.
- Static SPA assets via `env.ASSETS`.

Storage:
- **D1** (`DB`): albums, members (optional display names), media metadata, join audit.
- **R2** (`FILES`): media blobs, keyed `albums/{albumId}/{mediaId}`.

Real-time: client polls `GET /api/albums/:id/feed?since=<cursor>` every 3 s (configurable off via sync toggle).

Upload path (no size limit — verified design, final):
1. Client `POST /api/albums/:id/media` with metadata (kind, size, mime, uploader) → row created in `pending` state, returns `mediaId` + upload URL.
2. Files ≤ 24 MB: single streaming `PUT` through the worker straight into R2.
3. Files > 24 MB: client splits into ≤24 MB chunks; `POST /api/media/:id/parts` starts an R2 multipart upload; chunks PUT in parallel (3 at a time) to `/api/upload/:id?part=N&uploadId=…`; `POST /api/media/:id/parts/complete` assembles them. Only cap: R2's 10 GB per-object limit and device storage.
   (Note: the Workers R2 binding has no `createPresignedUrl` and Sites provides no S3 credentials, so direct-to-R2 presigned URLs are unavailable; the worker-proxied chunked path lifts the per-request limit instead.)
4. Client `POST /api/media/:id/complete` → row becomes `ready`, appears in feeds.
Rows stuck in `pending` > 24 h are ignored by feeds (swept lazily on read; no cron in v1).

Thumbnails: generated client-side (canvas) for photos/videos, uploaded as small R2 objects `.../{mediaId}.thumb`; audio gets a generated waveform SVG client-side.

## 4. Data model (D1)

```sql
albums(
  id TEXT PRIMARY KEY,            -- uuid
  code TEXT UNIQUE NOT NULL,      -- 6-digit
  name TEXT NOT NULL,
  pin TEXT,                       -- optional, hash (SHA-256)
  delete_policy TEXT NOT NULL,    -- everyone | host | uploader
  host_token TEXT NOT NULL,       -- secret; creator proves host status
  created_at INTEGER NOT NULL
)
media(
  id TEXT PRIMARY KEY,            -- uuid
  album_id TEXT NOT NULL REFERENCES albums(id),
  kind TEXT NOT NULL,             -- photo | video | audio
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader TEXT NOT NULL,         -- display name
  uploader_token TEXT,            -- secret per-device; proves uploader
  r2_key TEXT NOT NULL,
  thumb_key TEXT,
  state TEXT NOT NULL,            -- pending | ready
  width INTEGER, height INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
)
```

Indexes: `albums.code`, `media(album_id, created_at)`.

Access model (no accounts):
- Album row + `host_token` stored in creator's localStorage → host identity.
- On join, server issues `uploader_token` (random) which the device keeps; deletion of an item requires host token or item's uploader token per `delete_policy`.
- PIN checked at join; server then sets an HMAC-signed `album_session` cookie (key = Worker secret; payload = albumId + random device id) so guests don't re-enter the PIN on every sync. No sessions table.

## 5. API surface (Hono)

```
POST /api/albums              {name, pin?, deletePolicy} -> {albumId, code, hostToken}
POST /api/albums/join         {code, pin?, name}         -> {albumId, hostToken? , session}
GET  /api/albums/:id/feed     ?since=cursor&limit=100    -> {items[], nextCursor}
GET  /api/albums/:id/meta     (requires session or host) -> album meta + counts
POST /api/albums/:id/media    {kind,mime,size,uploader,...} -> {mediaId, uploadUrl}
POST /api/media/:id/complete                           -> {item}
GET  /api/media/:id/url                                -> {downloadUrl}
DELETE /api/media/:id         (host or uploader, policy-checked)
GET  /api/health
```

All album-scoped routes verify session cookie or host token; 401/403 otherwise. Mutations also check `isSameOrigin`-style Origin header for browser safety (no CSRF from foreign origins).

## 6. Frontend (vanilla TS + Vite PWA)

Screens (hash router):
- **Albums** — create/join cards, album list with code + "Never expires" badge.
- **Album feed** — live grid; per-card download icon; tap → detail; "Add photos / video / audio", "Sound Auto Shoot", "Manual Shoot", "Download all".
- **Camera** — fullscreen: mode switcher (Photo / Video / Audio), tilt-follow shutter button (manual mode), flash toggle (Auto/On/Off), screen-flash overlay on capture.
- **Photo/Video/Audio detail** — full-screen player/viewer, download, delete (if permitted), uploader + time.
- **Settings** — font size slider (5 levels → CSS `--font-scale`), default sensitivity (40–100 dB), screen flash toggle, real-time sync toggle, clear cache.
- **User Guide** — static content mirroring the reference app's 5 sections.

Design: dark theme (near-black violet-tinted surfaces, lavender accents) matching the screenshots' look; large touch targets; font-scale applied via root CSS variable.

## 7. Sound shutter

`getUserMedia({audio})` → `AnalyserNode`; compute RMS→dB-ish level (20·log10(rms) calibrated, labeled dB); when level exceeds threshold (slider) and cooldown (default 1.5 s) passed → capture photo. Live meter displayed. Auto-stops when leaving camera screen.

## 8. Offline outbox

IndexedDB queue of Blobs + metadata. If sync toggle on and network available → presign+PUT+complete; on failure → keep queued, retry with backoff on `online` event and 30 s timer. Sync toggle off pauses it. Items in outbox shown in feed as "queued" locally.

## 9. Error handling

- Join with wrong code/PIN → inline error, no leak of which was wrong beyond coarse message.
- Presign/PUT failure → toast + retry button; item stays queued.
- Delete denied by policy → server 403, UI hides delete button when known.
- Camera/mic permission denied → explanatory card with retry.
- Feed poll failure → banner "Reconnecting…", poll continues.

## 10. Testing

- `wrangler dev` (workerd) locally with local D1 + R2 bindings: create/join/PIN/presign/complete/feed/delete via script; verify signed-out and bad-session 401s; foreign-Origin mutation 403.
- UI verified in browser preview: create album, join in second context, upload photo, appear in second feed within poll cycle, download single + zip, delete permissions matrix.
- Camera/mic/sound-shutter verified as far as desktop hardware allows (deviceorientation + mic on desktop browser); remaining mobile-only behavior reported as untested.

## 11. Deployment

Sites: preview environment first with D1+R2 attached; user reviews live URL on phone before any production publish.
