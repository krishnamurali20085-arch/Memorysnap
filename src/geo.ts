export type GeoTag = { lat: number; lon: number; place: string | null };

const placeCache = new Map<string, string | null>();

export async function hasGeoPermission(): Promise<boolean> {
  if (!navigator.permissions) return false;
  try {
    const status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    return status.state === "granted";
  } catch {
    return false;
  }
}

export function getGeo(timeoutMs = 6000): Promise<GeoTag | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        reverseGeocode(lat, lon).then((place) => resolve({ lat, lon, place }));
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60 * 1000 },
    );
  });
}

export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (placeCache.has(key)) return placeCache.get(key) ?? null;
  let place: string | null = null;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&accept-language=en`,
      { headers: { Accept: "application/json" } },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        address?: { city?: string; town?: string; village?: string; suburb?: string; state?: string; country?: string };
      };
      const a = data.address || {};
      const local = a.city || a.town || a.village || a.suburb;
      place = local ? (a.country ? `${local}, ${a.country}` : local) : a.state || a.country || null;
    }
  } catch {
    /* offline or rate-limited — coordinates still stored */
  }
  placeCache.set(key, place);
  return place;
}
