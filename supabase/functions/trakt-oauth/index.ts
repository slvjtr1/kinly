// Trakt OAuth relay for Kinly's shared Trakt app.
//
// Trakt's device flow needs the app's client secret to swap a device code for tokens, and a
// secret can't be kept inside a desktop app. This function holds it (Edge Function secrets
// TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET, or else the service-role-only table private.trakt_app via
// the trakt_app_credentials() RPC) and forwards only Trakt's four OAuth endpoints.
// It stores and logs nothing; tokens go straight back to the caller.
//
// Abuse protection (see policy.ts): requests must carry the app's client key in the `apikey`
// header when KINLY_CLIENT_KEYS / the project's publishable keys are known, and each client IP is
// limited to IP_LIMIT requests per minute. The client key ships inside the public app, so it only
// keeps out casual callers; the rate limit and the fixed endpoint/field allowlist are what bound
// misuse. The limit is stored in the database (relay_allow RPC, IPs hashed) so it holds across
// function instances, with a per-instance in-memory limit as a fallback.
//
// GET  -> { configured, client_id }      (the client id is public; it identifies the app)
// POST { path, body } -> Trakt's response, status passed through

import { IP_LIMIT, MemoryLimiter, WINDOW_SEC, allowedKeys, clientIp, ipHash, keyAccepted } from "./policy.ts";

const TRAKT = "https://api.trakt.tv";
const PATHS = new Set(["/oauth/device/code", "/oauth/device/token", "/oauth/token", "/oauth/revoke"]);
const FIELDS = ["code", "refresh_token", "token", "grant_type"] as const;
const MAX_BODY = 4096;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

let cached: { id: string; secret: string; at: number } | null = null;

async function credentials(): Promise<{ id: string; secret: string }> {
  const id = Deno.env.get("TRAKT_CLIENT_ID") ?? "";
  const secret = Deno.env.get("TRAKT_CLIENT_SECRET") ?? "";
  if (id && secret) return { id, secret };
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { id: "", secret: "" };
  const r = await fetch(`${url}/rest/v1/rpc/trakt_app_credentials`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const rows = r.ok ? await r.json() : [];
  const row = Array.isArray(rows) ? rows[0] : null;
  const found = { id: row?.client_id ?? "", secret: row?.client_secret ?? "", at: Date.now() };
  if (found.id && found.secret) cached = found;
  return found;
}

const memoryLimit = new MemoryLimiter(IP_LIMIT, WINDOW_SEC * 1000);
const keys = allowedKeys((n) => Deno.env.get(n));

/** Counts the request against the caller's IP. Falls back to the in-memory limit if the database can't be reached. */
async function withinLimit(ip: string): Promise<boolean> {
  if (!memoryLimit.allow(ip)) return false;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return true;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/relay_allow`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_ip_hash: await ipHash(ip, key), p_limit: IP_LIMIT, p_window_sec: WINDOW_SEC }),
    });
    return r.ok ? (await r.json()) !== false : true;
  } catch {
    return true;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!keyAccepted(req.headers, keys)) return json({ error: "unauthorized" }, 401);
  if (!(await withinLimit(clientIp(req.headers) ?? "unknown"))) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(WINDOW_SEC) },
    });
  }

  const { id: clientId, secret: clientSecret } = await credentials();
  const redirectUri = Deno.env.get("TRAKT_REDIRECT_URI") ?? "http://localhost";
  const configured = clientId !== "" && clientSecret !== "";

  if (req.method === "GET") return json({ configured, client_id: configured ? clientId : null });
  if (!configured) return json({ error: "not_configured" }, 503);

  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: "too_large" }, 413);
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  if (!input || typeof input !== "object") return json({ error: "bad_request" }, 400);
  const { path, body } = input as { path?: unknown; body?: unknown };
  if (typeof path !== "string" || !PATHS.has(path) || !body || typeof body !== "object") return json({ error: "bad_request" }, 400);

  // Only known fields are forwarded; the app's credentials are added here.
  const out: Record<string, string> = { client_id: clientId };
  for (const k of FIELDS) {
    const v = (body as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length > 0 && v.length <= 512) out[k] = v;
  }
  if (path !== "/oauth/device/code") out.client_secret = clientSecret;
  if (path === "/oauth/token") out.redirect_uri = redirectUri;

  const r = await fetch(TRAKT + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Kinly" },
    body: JSON.stringify(out),
  });
  return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
});
