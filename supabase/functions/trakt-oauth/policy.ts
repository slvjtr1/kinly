// Request policy for the trakt-oauth relay: which callers are accepted and how often.
// Pure Web-API code so it can be unit-tested outside Deno.

/** Requests per client IP per window. Device-code polling needs about 12 a minute. */
export const IP_LIMIT = 40;
export const WINDOW_SEC = 60;

/** The caller's IP as seen by Supabase's gateway (first entry of X-Forwarded-For). */
export function clientIp(headers: Headers): string | null {
  const first = (headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return first && first.length <= 64 && /^[0-9a-fA-F.:]+$/.test(first) ? first : null;
}

/**
 * Client keys the relay accepts: KINLY_CLIENT_KEYS (comma-separated) plus the project's
 * publishable keys if the runtime provides them. Empty means "not restricted".
 */
export function allowedKeys(env: (name: string) => string | undefined): Set<string> {
  const keys = new Set<string>();
  for (const k of (env("KINLY_CLIENT_KEYS") ?? "").split(",")) if (k.trim()) keys.add(k.trim());
  try {
    const published = JSON.parse(env("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    if (published && typeof published === "object") {
      for (const v of Object.values(published)) if (typeof v === "string" && v) keys.add(v);
    }
  } catch {
    // not provided in this runtime
  }
  return keys;
}

/** True when the request carries one of the accepted client keys (or none are configured). */
export function keyAccepted(headers: Headers, allowed: Set<string>): boolean {
  if (allowed.size === 0) return true;
  const key = headers.get("apikey") ?? "";
  return key !== "" && allowed.has(key);
}

/** A salted SHA-256 of the IP, so the rate-limit table never holds addresses. */
export async function ipHash(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}\n${ip}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fixed-window counter per key, kept in memory. Bounded: old windows are dropped. */
export class MemoryLimiter {
  private hits = new Map<string, { window: number; n: number }>();
  constructor(private limit: number, private windowMs: number, private maxKeys = 10_000) {}

  allow(key: string, now = Date.now()): boolean {
    const window = Math.floor(now / this.windowMs);
    const h = this.hits.get(key);
    if (h && h.window === window) return ++h.n <= this.limit;
    if (this.hits.size >= this.maxKeys) {
      for (const [k, v] of this.hits) if (v.window !== window) this.hits.delete(k);
      if (this.hits.size >= this.maxKeys) return false;
    }
    this.hits.set(key, { window, n: 1 });
    return true;
  }
}
