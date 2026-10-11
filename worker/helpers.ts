const enc = new TextEncoder();

export function uuid(): string {
  return crypto.randomUUID();
}

export function randomToken(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = (buf[0] << 24 | buf[1] << 16 | buf[2] << 8 | buf[3]) >>> 0;
  return String(100000 + (n % 900000));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signValue(secret: string, value: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(value));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyValue(secret: string, value: string, signature: string): Promise<boolean> {
  const expected = await signValue(secret, value);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function mintSession(secret: string, albumId: string, deviceId: string): Promise<string> {
  const sig = await signValue(secret, `${albumId}.${deviceId}`);
  return `${deviceId}.${sig}`;
}

export async function checkSession(
  secret: string,
  albumId: string,
  cookieValue: string | undefined,
): Promise<string | null> {
  if (!cookieValue) return null;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return null;
  const deviceId = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const ok = await verifyValue(secret, `${albumId}.${deviceId}`, sig);
  return ok ? deviceId : null;
}
