export type Settings = {
  fontSize: 1 | 2 | 3 | 4 | 5;
  sensitivity: number; // 40..100 dB label
  screenFlash: boolean;
  syncEnabled: boolean;
};

export type AlbumEntry = {
  id: string;
  code: string;
  name: string;
  deletePolicy: string;
  hostToken?: string;
  uploaderToken: string;
  displayName: string;
};

const SETTINGS_KEY = "fps:settings";
const ALBUMS_KEY = "fps:albums";
const DEVICE_KEY = "fps:deviceId";
const USER_KEY = "fps:user";

export type UserRecord = { userId: string; phone: string; username: string | null; displayName: string | null };

const DEFAULTS: Settings = { fontSize: 2, sensitivity: 75, screenFlash: true, syncEnabled: true };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function getSettings(): Settings {
  return { ...DEFAULTS, ...read<Partial<Settings>>(SETTINGS_KEY, {}) };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  applyFontScale(next);
  return next;
}

export function applyFontScale(s: Settings = getSettings()) {
  const scale = [0.85, 0.925, 1, 1.15, 1.3][s.fontSize - 1] ?? 1;
  document.documentElement.style.setProperty("--font-scale", String(scale));
}

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getAlbums(): Record<string, AlbumEntry> {
  return read<Record<string, AlbumEntry>>(ALBUMS_KEY, {});
}

export function getAlbum(id: string): AlbumEntry | undefined {
  return getAlbums()[id];
}

export function saveAlbum(entry: AlbumEntry) {
  const all = getAlbums();
  all[entry.id] = entry;
  localStorage.setItem(ALBUMS_KEY, JSON.stringify(all));
}

export function removeAlbum(id: string) {
  const all = getAlbums();
  delete all[id];
  localStorage.setItem(ALBUMS_KEY, JSON.stringify(all));
}

export function getUser(): UserRecord | null {
  return read<UserRecord | null>(USER_KEY, null);
}

export function saveUser(user: UserRecord) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearUser() {
  localStorage.removeItem(USER_KEY);
}

export function getDisplayName(): string {
  const user = getUser();
  if (user?.username) return user.username;
  return localStorage.getItem("fps:name") || "Guest";
}

export function setUsername(username: string) {
  const user = getUser();
  if (user) saveUser({ ...user, username });
  localStorage.setItem("fps:name", username);
}

export function setDisplayName(name: string) {
  localStorage.setItem("fps:name", name.trim().slice(0, 40) || "Guest");
}
