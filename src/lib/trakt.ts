// Trakt: device-code sign-in, watchlist/history import and playback scrobbling.
// By default Kinly's shared Trakt app is used: its secret stays in a Supabase Edge Function
// (supabase/functions/trakt-oauth) that relays the four OAuth calls, so users only enter a code on
// trakt.tv/activate. Advanced users can use their own Trakt app instead. Credentials and tokens live
// in the "trakt" store (written 0600 by Rust), one entry per profile (and one for guest mode):
// {v: 2, profiles: {[profileId | "guest"]: {clientId?, clientSecret?, tokens?, lastSync?}}}.
// They are never uploaded. No token is ever logged.

import { useSyncExternalStore } from "react";
import type { LibItem, LibraryDoc, Progress } from "./library";
import { progressKey } from "./library";
import { GUEST, getOwner, onOwnerChange, onProfileDeleted, ownerKeyOk } from "./owner";
import { importIntoLibrary } from "./sync";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./supabaseConfig";
import { http, storeLoad, storeSave, uiLog, type HttpResponse } from "./tauri";

export const TRAKT_API = "https://api.trakt.tv";
export const TRAKT_APPS_URL = "https://trakt.tv/oauth/applications";
export const TRAKT_REDIRECT = "http://localhost";
export const TRAKT_RELAY = `${SUPABASE_URL}/functions/v1/trakt-oauth`;
/** Identifies Kinly to the relay, which rejects requests without it. */
const RELAY_HEADERS: Record<string, string> = { apikey: SUPABASE_PUBLISHABLE_KEY };
const AUTO_SYNC_MS = 15 * 60_000;

export type TraktTokens = { access_token: string; refresh_token: string; expires_at: number };
/** One profile's Trakt connection. */
export type TraktEntry = { clientId?: string; clientSecret?: string; tokens?: TraktTokens; lastSync?: number };
export type TraktStoreDoc = { v: 2; profiles: Record<string, TraktEntry> };
/** The entry uses the user's own Trakt app when it has a secret; otherwise Kinly's shared app. */
const ownApp = (d: TraktEntry) => !!(d.clientId && d.clientSecret);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const TOKEN = /^[A-Za-z0-9._~+/=-]{8,512}$/;

export const looksLikeTraktCredential = (s: string) => /^[A-Za-z0-9_-]{20,128}$/.test(s.trim());

/** Validates a Trakt token response. */
export function parseTraktTokens(x: unknown, nowMs = Date.now()): TraktTokens | null {
  if (!isObj(x)) return null;
  const { access_token, refresh_token, expires_in, created_at } = x;
  if (typeof access_token !== "string" || !TOKEN.test(access_token)) return null;
  if (typeof refresh_token !== "string" || !TOKEN.test(refresh_token)) return null;
  if (typeof expires_in !== "number" || !(expires_in > 0) || expires_in > 10 * 365 * 86400) return null;
  const created = typeof created_at === "number" && created_at > 0 && created_at * 1000 <= nowMs + 86_400_000 ? created_at * 1000 : nowMs;
  return { access_token, refresh_token, expires_at: created + expires_in * 1000 };
}

function parseEntry(x: unknown): TraktEntry | null {
  if (!isObj(x)) return null;
  const d: TraktEntry = {};
  if (typeof x.clientId === "string" && looksLikeTraktCredential(x.clientId)) d.clientId = x.clientId;
  if (typeof x.clientSecret === "string" && looksLikeTraktCredential(x.clientSecret)) d.clientSecret = x.clientSecret;
  if (isObj(x.tokens)) {
    const t = x.tokens;
    if (typeof t.access_token === "string" && TOKEN.test(t.access_token) && typeof t.refresh_token === "string" && TOKEN.test(t.refresh_token) && typeof t.expires_at === "number") {
      d.tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at };
    }
  }
  if (typeof x.lastSync === "number" && Number.isFinite(x.lastSync)) d.lastSync = x.lastSync;
  return Object.keys(d).length ? d : null;
}

/**
 * Reads the "trakt" store. A v1 document (one connection for everyone) comes back as `legacy`; it
 * is given to whichever owner is active first (migrateTrakt).
 */
export function parseTraktStore(x: unknown): { doc: TraktStoreDoc; legacy: TraktEntry | null } {
  const doc: TraktStoreDoc = { v: 2, profiles: {} };
  if (!isObj(x)) return { doc, legacy: null };
  if (x.v === 2 && isObj(x.profiles)) {
    for (const [k, e] of Object.entries(x.profiles)) {
      const entry = parseEntry(e);
      if (ownerKeyOk(k) && entry) doc.profiles[k] = entry;
    }
    return { doc, legacy: null };
  }
  return { doc, legacy: parseEntry(x) };
}

/** Moves a v1 connection into `owner` unless that owner already has one. True when the doc changed. */
export function migrateTrakt(doc: TraktStoreDoc, legacy: TraktEntry | null, owner: string): boolean {
  if (!legacy) return false;
  if (!doc.profiles[owner]) doc.profiles[owner] = legacy;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Device-code polling (pure state machine around http; unit tested)

export type DeviceCode = { device_code: string; user_code: string; verification_url: string; expires_in: number; interval: number };

export function parseDeviceCode(x: unknown): DeviceCode | null {
  if (!isObj(x)) return null;
  const { device_code, user_code, verification_url, expires_in, interval } = x;
  if (typeof device_code !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(device_code)) return null;
  if (typeof user_code !== "string" || !/^[A-Za-z0-9-]{4,16}$/.test(user_code)) return null;
  if (typeof expires_in !== "number" || !(expires_in > 0) || expires_in > 3600) return null;
  if (typeof interval !== "number" || !(interval > 0) || interval > 60) return null;
  const url = typeof verification_url === "string" && /^https:\/\/(auth\.|www\.)?trakt\.tv\/[\w/-]*$/.test(verification_url) ? verification_url : "https://trakt.tv/activate";
  return { device_code, user_code, verification_url: url, expires_in, interval };
}

export type PollOutcome =
  | { kind: "ok"; tokens: TraktTokens }
  | { kind: "expired" | "denied" | "invalid" | "used" | "cancelled" }
  | { kind: "error"; message: string };

export type PollDeps = { sleep: (ms: number) => Promise<void>; now: () => number; cancelled: () => boolean; onSlowDown?: (intervalSec: number) => void };

const jsonHeaders = (clientId: string, token?: string): Record<string, string> => ({
  "Content-Type": "application/json",
  "trakt-api-version": "2",
  "trakt-api-key": clientId,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

/**
 * POSTs to one of Trakt's OAuth endpoints. With the user's own app the credentials are added here;
 * without a secret the call goes through Kinly's relay, which adds the shared app's credentials.
 */
export function oauthPost(path: string, body: Record<string, string>, app: { clientId: string; clientSecret?: string }): Promise<HttpResponse> {
  if (app.clientSecret) {
    const full = { ...body, client_id: app.clientId, ...(path === "/oauth/device/code" ? {} : { client_secret: app.clientSecret }) };
    return http(`${TRAKT_API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(full), timeoutMs: 15000 });
  }
  return http(TRAKT_RELAY, { method: "POST", headers: { ...RELAY_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ path, body }), timeoutMs: 20000 });
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Polls /oauth/device/token every `interval` seconds until the user approves, denies, or the code expires.
 * 400 = still pending, 404 = invalid code, 409 = already used, 410 = expired, 418 = denied, 429 = slow down.
 */
export async function pollDeviceToken(
  p: { deviceCode: string; clientId: string; clientSecret?: string; intervalSec: number; expiresInSec: number },
  d: PollDeps,
): Promise<PollOutcome> {
  let interval = Math.max(1, p.intervalSec);
  const deadline = d.now() + p.expiresInSec * 1000;
  let networkErrors = 0;
  for (;;) {
    await d.sleep(interval * 1000);
    if (d.cancelled()) return { kind: "cancelled" };
    if (d.now() >= deadline) return { kind: "expired" };
    let r: HttpResponse;
    try {
      r = await oauthPost("/oauth/device/token", { code: p.deviceCode }, p);
    } catch {
      if (++networkErrors >= 5) return { kind: "error", message: "Lost connection to Trakt." };
      continue;
    }
    if (d.cancelled()) return { kind: "cancelled" };
    networkErrors = 0;
    switch (r.status) {
      case 200: {
        const tokens = parseTraktTokens(safeJson(r.body), d.now());
        return tokens ? { kind: "ok", tokens } : { kind: "error", message: "Unexpected response from Trakt." };
      }
      case 400:
        continue; // pending
      case 404:
        return { kind: "invalid" };
      case 409:
        return { kind: "used" };
      case 410:
        return { kind: "expired" };
      case 418:
        return { kind: "denied" };
      case 429:
        interval += 5;
        d.onSlowDown?.(interval);
        continue;
      default:
        if (r.status >= 500) continue;
        return { kind: "error", message: `Trakt answered HTTP ${r.status}.` };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Mapping Trakt responses to the Kinly library (pure; unit tested)

const IMDB = /^tt\d{1,10}$/;
const title = (v: unknown) => (typeof v === "string" ? v.slice(0, 512) : "");
const time = (v: unknown, fallback: number) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? Math.min(t, Date.now() + 86_400_000) : fallback;
};
function imdbOf(media: unknown): string | null {
  if (!isObj(media) || !isObj(media.ids)) return null;
  const id = media.ids.imdb;
  return typeof id === "string" && IMDB.test(id) ? id : null;
}

export function mapWatchlist(rows: unknown, kind: "movie" | "show"): LibItem[] {
  if (!Array.isArray(rows)) return [];
  const out: LibItem[] = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    const media = r[kind];
    const id = imdbOf(media);
    if (!id) continue;
    out.push({ id, type: kind === "movie" ? "movie" : "series", name: title((media as Record<string, unknown>).title), addedAt: time(r.listed_at, 0) });
  }
  return out;
}

const watchedEntry = (o: { type: string; metaId: string; videoId: string; name: string; at: number; season?: number; episode?: number }): Progress => ({
  key: progressKey(o.type, o.videoId),
  metaId: o.metaId,
  type: o.type,
  name: o.name,
  videoId: o.videoId,
  ...(o.season !== undefined ? { season: o.season, episode: o.episode } : {}),
  position: 0,
  duration: 0,
  watched: true,
  updatedAt: o.at,
});

export function mapWatchedMovies(rows: unknown): Progress[] {
  if (!Array.isArray(rows)) return [];
  const out: Progress[] = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    const id = imdbOf(r.movie);
    if (!id) continue;
    out.push(watchedEntry({ type: "movie", metaId: id, videoId: id, name: title((r.movie as Record<string, unknown>).title), at: time(r.last_watched_at, 0) }));
  }
  return out;
}

export function mapWatchedShows(rows: unknown): Progress[] {
  if (!Array.isArray(rows)) return [];
  const out: Progress[] = [];
  for (const r of rows) {
    if (!isObj(r) || !Array.isArray(r.seasons)) continue;
    const id = imdbOf(r.show);
    if (!id) continue;
    const name = title((r.show as Record<string, unknown>).title);
    const showAt = time(r.last_watched_at, 0);
    for (const s of r.seasons) {
      if (!isObj(s) || !Number.isInteger(s.number) || !Array.isArray(s.episodes)) continue;
      const season = s.number as number;
      if (season < 0 || season > 9999) continue;
      for (const e of s.episodes) {
        if (!isObj(e) || !Number.isInteger(e.number)) continue;
        const episode = e.number as number;
        if (episode < 0 || episode > 99999) continue;
        out.push(watchedEntry({ type: "series", metaId: id, videoId: `${id}:${season}:${episode}`, name, season, episode, at: time(e.last_watched_at, showAt) }));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// State

export type TraktPhase =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "code"; userCode: string; url: string; expiresAt: number }
  | { kind: "error"; message: string };

export type TraktState = {
  loaded: boolean;
  configured: boolean;
  connected: boolean;
  clientId: string;
  phase: TraktPhase;
  syncing: boolean;
  lastSync: number | null;
  lastResult: string | null;
  error: string | null;
};

let store: TraktStoreDoc = { v: 2, profiles: {} };
let legacy: TraktEntry | null = null;
/** The active owner ("guest" or a profile id); null until sync.ts has said whose data is active. */
let active: string | null = null;
/** The active owner's entry. */
let doc: TraktEntry = {};
let state: TraktState = { loaded: false, configured: false, connected: false, clientId: "", phase: { kind: "idle" }, syncing: false, lastSync: null, lastResult: null, error: null };
const subs = new Set<() => void>();
function setState(patch: Partial<TraktState>) {
  state = { ...state, ...patch, configured: ownApp(doc), connected: !!doc.tokens, clientId: doc.clientId ?? "", lastSync: doc.lastSync ?? null };
  subs.forEach((f) => f());
}
export const getTrakt = () => state;
export function useTrakt(): TraktState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}

const entry = (k: string): TraktEntry => store.profiles[k] ?? {};
/** Writes one owner's entry and saves the store. */
function put(k: string, e: TraktEntry): Promise<void> {
  const profiles = { ...store.profiles };
  if (Object.values(e).some((v) => v !== undefined)) profiles[k] = e;
  else delete profiles[k];
  store = { v: 2, profiles };
  if (k === active) doc = e;
  return storeSave("trakt", store);
}
/** Other owners that share this access token (a connection copied to a new profile). */
const sharing = (k: string, access: string) => Object.entries(store.profiles).filter(([o, e]) => o !== k && e.tokens?.access_token === access).map(([o]) => o);

let storeLoaded = false;
let firstTimer: ReturnType<typeof setTimeout> | undefined;
const auto = () => {
  if (doc.tokens && Date.now() - (doc.lastSync ?? 0) >= AUTO_SYNC_MS) void traktSyncNow();
};

/** Makes `owner`'s connection the active one: cancels a connect in progress and restarts auto-sync. */
function activate(owner: string) {
  if (!storeLoaded) {
    active = owner;
    return;
  }
  connectRun++;
  active = owner;
  if (migrateTrakt(store, legacy, owner)) {
    legacy = null;
    void storeSave("trakt", store).catch(() => {});
  }
  doc = entry(owner);
  setState({ loaded: true, phase: { kind: "idle" }, syncing: syncingFor === owner, lastResult: null, error: null });
  // Give the library and profile a moment to load first.
  clearTimeout(firstTimer);
  firstTimer = setTimeout(auto, 8000);
}

onOwnerChange(activate);
onProfileDeleted((id) => void forgetTraktProfile(id));

let started = false;
export async function initTrakt(): Promise<void> {
  if (started) return;
  started = true;
  try {
    ({ doc: store, legacy } = parseTraktStore((await storeLoad<unknown>("trakt")).value));
  } catch {
    store = { v: 2, profiles: {} };
  }
  storeLoaded = true;
  const owner = active ?? getOwner();
  if (owner) activate(owner);
  setInterval(auto, AUTO_SYNC_MS);
}

/** Test hook: replaces the loaded store and activates `owner` without touching disk first. */
export function loadTraktStoreForTests(x: unknown, owner: string) {
  ({ doc: store, legacy } = parseTraktStore(x));
  storeLoaded = true;
  active = null;
  activate(owner);
}

const requireOwner = () => {
  if (!active || !storeLoaded) throw new Error("Trakt is still loading.");
  return active;
};

export async function saveTraktApp(clientId: string, clientSecret: string): Promise<void> {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!looksLikeTraktCredential(id) || !looksLikeTraktCredential(secret)) throw new Error("Paste the Client ID and Client Secret exactly as Trakt shows them.");
  const k = requireOwner();
  if (doc.tokens) await disconnectTrakt();
  await put(k, { ...entry(k), clientId: id, clientSecret: secret });
  setState({ error: null });
}

export async function forgetTraktApp(): Promise<void> {
  const k = requireOwner();
  if (doc.tokens) await disconnectTrakt();
  await put(k, {});
  setState({ phase: { kind: "idle" }, lastResult: null, error: null });
}

let connectRun = 0;
/** The shared app's public client id, from the relay (needed as trakt-api-key for API calls). */
async function sharedClientId(): Promise<string> {
  const r = await http(TRAKT_RELAY, { headers: RELAY_HEADERS, timeoutMs: 15000 });
  const j = safeJson(r.body);
  const id = isObj(j) && j.configured === true && typeof j.client_id === "string" ? j.client_id : null;
  if (r.status !== 200 || !id || !looksLikeTraktCredential(id)) throw new Error("Kinly's Trakt connection isn't available right now. You can use your own Trakt app under Advanced.");
  return id;
}

export async function startTraktConnect(): Promise<void> {
  const k = requireOwner();
  const run = ++connectRun;
  setState({ phase: { kind: "requesting" }, error: null });
  let code: DeviceCode | null = null;
  let app: { clientId: string; clientSecret?: string };
  try {
    app = ownApp(doc) ? { clientId: doc.clientId!, clientSecret: doc.clientSecret } : { clientId: await sharedClientId() };
    const r = await oauthPost("/oauth/device/code", {}, app);
    code = r.status === 200 ? parseDeviceCode(safeJson(r.body)) : null;
    if (!code) throw new Error(r.status === 401 || r.status === 403 ? "Trakt rejected the Client ID. Check it in your Trakt app settings." : `Trakt answered HTTP ${r.status}.`);
  } catch (e) {
    if (run === connectRun) setState({ phase: { kind: "error", message: e instanceof Error ? e.message : "Couldn't reach Trakt." } });
    return;
  }
  if (run !== connectRun) return;
  setState({ phase: { kind: "code", userCode: code.user_code, url: code.verification_url, expiresAt: Date.now() + code.expires_in * 1000 } });
  const outcome = await pollDeviceToken(
    { deviceCode: code.device_code, ...app, intervalSec: code.interval, expiresInSec: code.expires_in },
    { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, cancelled: () => run !== connectRun },
  );
  // A profile switch bumps connectRun, so a code approved after switching is dropped.
  if (run !== connectRun || outcome.kind === "cancelled" || k !== active) return;
  if (outcome.kind === "ok") {
    await put(k, { ...entry(k), clientId: app.clientId, tokens: outcome.tokens });
    setState({ phase: { kind: "idle" } });
    void uiLog("info", "trakt: connected");
    void traktSyncNow();
    return;
  }
  const messages: Record<string, string> = {
    expired: "The code expired. Start again to get a new one.",
    denied: "Access was denied on Trakt.",
    invalid: "Trakt didn't recognise this code. Start again.",
    used: "This code was already used. Start again.",
  };
  setState({ phase: { kind: "error", message: outcome.kind === "error" ? outcome.message : messages[outcome.kind] } });
}

export function cancelTraktConnect() {
  connectRun++;
  setState({ phase: { kind: "idle" } });
}

const refreshing = new Map<string, Promise<boolean>>();
/** Refreshes owner `k`'s tokens (single flight per owner). Profiles sharing the old token get the new one too. */
function refreshTokens(k: string): Promise<boolean> {
  const inflight = refreshing.get(k);
  if (inflight) return inflight;
  const p = (async () => {
    const { clientId, clientSecret, tokens } = entry(k);
    if (!clientId || !tokens) return false;
    const body: Record<string, string> = { refresh_token: tokens.refresh_token, grant_type: "refresh_token" };
    if (clientSecret) body.redirect_uri = TRAKT_REDIRECT;
    const shared = sharing(k, tokens.access_token);
    const r = await oauthPost("/oauth/token", body, { clientId, clientSecret });
    if (r.status === 200) {
      const t = parseTraktTokens(safeJson(r.body));
      if (!t) return false;
      for (const o of shared) if (entry(o).tokens?.access_token === tokens.access_token) await put(o, { ...entry(o), tokens: t });
      await put(k, { ...entry(k), tokens: t });
      return true;
    }
    if (r.status === 400 || r.status === 401) {
      await put(k, { ...entry(k), tokens: undefined });
      if (k === active) setState({ error: "Trakt access expired. Connect again." });
      void uiLog("warn", "trakt: refresh rejected; disconnected");
    }
    return false;
  })().finally(() => {
    refreshing.delete(k);
  });
  refreshing.set(k, p);
  return p;
}

/** Authenticated Trakt API call for owner `k`; refreshes the token when it is near expiry or after a 401. */
async function api(k: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<HttpResponse> {
  const e = entry(k);
  if (!e.tokens || !e.clientId) throw new Error("Trakt is not connected.");
  if (e.tokens.expires_at - Date.now() < 60 * 60_000) await refreshTokens(k);
  const send = () => {
    const cur = entry(k);
    return http(`${TRAKT_API}${path}`, {
      method: init.method ?? "GET",
      headers: jsonHeaders(cur.clientId ?? e.clientId!, cur.tokens?.access_token),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      timeoutMs: 30000,
    });
  };
  let r = await send();
  if (r.status === 401 && (await refreshTokens(k))) r = await send();
  return r;
}

async function getJson(k: string, path: string): Promise<unknown> {
  const r = await api(k, path);
  if (r.status !== 200) throw new Error(r.status === 401 ? "Trakt access expired. Connect again." : `Trakt answered HTTP ${r.status}.`);
  const j = safeJson(r.body);
  if (j === null) throw new Error("Unexpected response from Trakt.");
  return j;
}

async function getPaged(k: string, path: string, maxPages = 50): Promise<unknown[]> {
  const out: unknown[] = [];
  const limit = 100;
  for (let page = 1; page <= maxPages; page++) {
    const rows = await getJson(k, `${path}?page=${page}&limit=${limit}`);
    if (!Array.isArray(rows)) break;
    out.push(...rows);
    if (rows.length < limit) break;
  }
  return out;
}

/** Revokes a token on Trakt unless another profile on this device still uses it. */
async function revokeUnlessShared(k: string, e: TraktEntry) {
  if (!e.clientId || !e.tokens || sharing(k, e.tokens.access_token).length) return;
  try {
    await oauthPost("/oauth/revoke", { token: e.tokens.access_token }, { clientId: e.clientId, clientSecret: e.clientSecret });
  } catch {
    // Offline: forget it locally anyway.
  }
}

export async function disconnectTrakt(): Promise<void> {
  const k = requireOwner();
  connectRun++;
  await revokeUnlessShared(k, entry(k));
  await put(k, { ...entry(k), tokens: undefined, lastSync: undefined });
  setState({ phase: { kind: "idle" }, lastResult: null, error: null });
}

/** Forgets a deleted profile's connection on this device. */
export async function forgetTraktProfile(profileId: string): Promise<void> {
  if (!storeLoaded || !store.profiles[profileId]) return;
  const e = entry(profileId);
  await put(profileId, {}).catch(() => {});
  if (e.tokens) await revokeUnlessShared(profileId, e);
}

/**
 * Copies one profile's Trakt connection (tokens and own-app id/secret) to another profile on this
 * device. Both then use the same Trakt authorisation; a token refresh updates both copies.
 */
export async function copyTraktConnection(from: string, to: string): Promise<boolean> {
  if (!storeLoaded) {
    try {
      ({ doc: store, legacy } = parseTraktStore((await storeLoad<unknown>("trakt")).value));
      storeLoaded = true;
    } catch {
      return false;
    }
  }
  const e = entry(from);
  if (!ownerKeyOk(to) || to === GUEST || (!e.tokens && !ownApp(e))) return false;
  const copy: TraktEntry = { clientId: e.clientId, clientSecret: e.clientSecret, tokens: e.tokens ? { ...e.tokens } : undefined };
  await put(to, copy);
  if (to === active) setState({});
  return true;
}

/** Whether a profile has a Trakt connection or its own Trakt app on this device. */
export const hasTraktConnection = (profileId: string) => !!(entry(profileId).tokens || ownApp(entry(profileId)));

let syncing: Promise<void> | null = null;
let syncingFor: string | null = null;
let syncToken: object | null = null;
/** Imports the active profile's Trakt watchlist and watched history into its Kinly library. */
export function traktSyncNow(): Promise<void> {
  const k = active;
  if (syncing && syncingFor === k) return syncing;
  if (!k || !doc.tokens) return Promise.resolve();
  setState({ syncing: true, error: null });
  syncingFor = k;
  const token = {};
  syncToken = token;
  const run: Promise<void> = (async () => {
    try {
      const [wm, ws, hm, hs] = await Promise.all([
        getPaged(k, "/sync/watchlist/movies"),
        getPaged(k, "/sync/watchlist/shows"),
        getJson(k, "/sync/watched/movies"),
        getJson(k, "/sync/watched/shows"),
      ]);
      // Switched profile meanwhile: never import one profile's Trakt data into another's library.
      if (k !== active) return;
      const watchlist = [...mapWatchlist(wm, "movie"), ...mapWatchlist(ws, "show")];
      const progress = [...mapWatchedMovies(hm), ...mapWatchedShows(hs)];
      const part: LibraryDoc = { watchlist, progress: Object.fromEntries(progress.map((p) => [p.key, p])), tombstones: {} };
      importIntoLibrary(part);
      await put(k, { ...entry(k), lastSync: Date.now() });
      setState({ syncing: false, lastResult: `${watchlist.length} watchlist items, ${progress.length} watched entries` });
    } catch (e) {
      if (k === active) setState({ syncing: false, error: e instanceof Error ? e.message : "Trakt sync failed." });
    } finally {
      if (syncToken === token) {
        syncing = null;
        syncingFor = null;
      }
      if (k !== active && state.syncing && syncingFor !== active) setState({ syncing: false });
    }
  })();
  syncing = run;
  return run;
}

// ---------------------------------------------------------------------------------------------
// Scrobbling

export type ScrobbleItem = { type: string; metaId: string; season?: number; episode?: number };

/** Builds the scrobble body, or null when the item can't be identified on Trakt (local files, non-IMDb ids). */
export function scrobbleBody(item: ScrobbleItem, progressPct: number): Record<string, unknown> | null {
  const imdb = item.metaId.split(":")[0];
  if (!IMDB.test(imdb)) return null;
  const progress = Math.round(Math.min(100, Math.max(0, Number.isFinite(progressPct) ? progressPct : 0)) * 100) / 100;
  if (item.type === "movie") return { movie: { ids: { imdb } }, progress };
  if (item.type === "series" && Number.isInteger(item.season) && Number.isInteger(item.episode)) {
    return { show: { ids: { imdb } }, episode: { season: item.season, number: item.episode }, progress };
  }
  return null;
}

let lastScrobble = { sig: "", at: 0 };
/**
 * Tells Trakt about playback: call with "start" when playback starts or resumes, "pause" when
 * paused, "stop" when it ends or the player closes. `progressPct` is 0..100. Never throws.
 */
export async function traktScrobble(kind: "start" | "pause" | "stop", item: ScrobbleItem, progressPct: number): Promise<boolean> {
  const k = active;
  if (!k || !doc.tokens) return false;
  const body = scrobbleBody(item, progressPct);
  if (!body) return false;
  const sig = `${kind}|${item.metaId}|${item.season ?? ""}|${item.episode ?? ""}`;
  if (sig === lastScrobble.sig && Date.now() - lastScrobble.at < 3000) return false;
  lastScrobble = { sig, at: Date.now() };
  try {
    const r = await api(k, `/scrobble/${kind}`, { method: "POST", body });
    return r.status === 201 || r.status === 200 || r.status === 409;
  } catch {
    return false;
  }
}
