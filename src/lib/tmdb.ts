// Optional TMDB connection: "More like this" recommendations.
// The key is the user's own. Each profile (and guest mode) has its own key, kept in the
// "credentials" store (file mode 0600) as {v: 2, profiles: {[profileId | "guest"]: {tmdb: {key}}}}.
// It is never uploaded and is only ever sent to api.themoviedb.org.

import { GUEST, getOwner, onOwnerChange, onProfileDeleted, ownerKeyOk } from "./owner";
import { http, storeLoad, storeSave } from "./tauri";

const API = "https://api.themoviedb.org/3";
export const TMDB_IMAGE = "https://image.tmdb.org/t/p/w342";

export type TmdbEntry = { tmdb?: { key: string } };
export type CredentialsDoc = { v: 2; profiles: Record<string, TmdbEntry> };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function parseEntry(x: unknown): TmdbEntry | null {
  if (!isObj(x) || !isObj(x.tmdb)) return null;
  const key = x.tmdb.key;
  return typeof key === "string" && key.length > 0 && key.length <= 1024 ? { tmdb: { key } } : null;
}

/**
 * Reads the credentials store. A v1 document (one key for everyone) is returned as `legacy`, to be
 * given to whichever owner is active first (migrateCredentials).
 */
export function parseCredentials(x: unknown): { doc: CredentialsDoc; legacy: TmdbEntry | null } {
  const doc: CredentialsDoc = { v: 2, profiles: {} };
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

/** Moves a v1 key into `owner` (unless that owner already has one). Returns true when it changed the doc. */
export function migrateCredentials(doc: CredentialsDoc, legacy: TmdbEntry | null, owner: string): boolean {
  if (!legacy) return false;
  if (!doc.profiles[owner]) doc.profiles[owner] = legacy;
  return true;
}

let doc: CredentialsDoc = { v: 2, profiles: {} };
let legacy: TmdbEntry | null = null;
let owner: string | null = getOwner();
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const save = () => storeSave("credentials", doc);

function migrate() {
  if (owner && migrateCredentials(doc, legacy, owner)) {
    legacy = null;
    void save().catch(() => {});
  }
}

export function loadCredentials(): Promise<void> {
  loaded ??= storeLoad<unknown>("credentials")
    .then((r) => void ({ doc, legacy } = parseCredentials(r.value)))
    .catch(() => void (doc = { v: 2, profiles: {} }))
    .then(() => {
      migrate();
      notify();
    });
  return loaded;
}

onOwnerChange((o) => {
  owner = o;
  if (loaded) void loaded.then(migrate);
  notify();
});
onProfileDeleted((id) => {
  void loadCredentials().then(() => {
    if (!doc.profiles[id]) return;
    delete doc.profiles[id];
    void save().catch(() => {});
  });
});

export const subscribeCredentials = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** The active profile's TMDB key (null until the active profile is known). */
export const tmdbKey = () => (owner ? (doc.profiles[owner]?.tmdb?.key ?? null) : null);

/** Sets or clears the active profile's key. */
export async function setTmdbKey(key: string | null): Promise<void> {
  await loadCredentials();
  const who = owner ?? GUEST;
  const profiles = { ...doc.profiles };
  if (key) profiles[who] = { tmdb: { key } };
  else delete profiles[who];
  const next: CredentialsDoc = { v: 2, profiles };
  await storeSave("credentials", next);
  doc = next;
  notify();
}

/** Copies one profile's TMDB key to another on this device (create-profile option). */
export async function copyTmdbConnection(from: string, to: string): Promise<boolean> {
  await loadCredentials();
  const e = doc.profiles[from];
  if (!e?.tmdb || !ownerKeyOk(to)) return false;
  doc = { v: 2, profiles: { ...doc.profiles, [to]: { tmdb: { ...e.tmdb } } } };
  await save();
  notify();
  return true;
}

/** Whether a profile has a TMDB key on this device. */
export async function hasTmdbConnection(profileId: string): Promise<boolean> {
  await loadCredentials();
  return !!doc.profiles[profileId]?.tmdb;
}

/** v4 "API Read Access Tokens" are JWTs sent as a bearer token; v3 keys are 32 hex characters. */
export function tmdbRequest(path: string, key: string, params: Record<string, string> = {}): { url: string; headers: Record<string, string> } {
  const q = new URLSearchParams(params);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  else q.set("api_key", key);
  const qs = q.toString();
  return { url: `${API}${path}${qs ? `?${qs}` : ""}`, headers };
}

async function get<T>(path: string, params: Record<string, string> = {}, key = tmdbKey()): Promise<T> {
  if (!key) throw new Error("TMDB is not connected");
  const { url, headers } = tmdbRequest(path, key, params);
  const r = await http(url, { headers, timeoutMs: 15000 });
  if (r.status === 401) throw new Error("TMDB rejected the API key");
  if (r.status !== 200) throw new Error(`TMDB error (HTTP ${r.status})`);
  return JSON.parse(r.body) as T;
}

export function looksLikeTmdbKey(key: string): boolean {
  return /^[0-9a-f]{32}$/i.test(key) || /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(key);
}

/** Checks a key against TMDB before it is saved. */
export async function testTmdbKey(key: string): Promise<void> {
  await get("/configuration", {}, key);
}

export type Recommendation = {
  tmdbId: number;
  type: "movie" | "series";
  title: string;
  year?: string;
  poster?: string;
  background?: string;
  tmdbRating?: number;
};

type TmdbItem = {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
};

export function mapResults(items: TmdbItem[], type: "movie" | "series"): Recommendation[] {
  return items
    .filter((i) => i.poster_path)
    .map((i) => ({
      tmdbId: i.id,
      type,
      title: i.title ?? i.name ?? "",
      year: (i.release_date ?? i.first_air_date ?? "").slice(0, 4) || undefined,
      poster: `${TMDB_IMAGE}${i.poster_path}`,
      background: i.backdrop_path ? `https://image.tmdb.org/t/p/w780${i.backdrop_path}` : undefined,
      tmdbRating: i.vote_count ? Math.round((i.vote_average ?? 0) * 10) / 10 : undefined,
    }));
}

const tmdbPath = (type: "movie" | "series") => (type === "movie" ? "movie" : "tv");

/** Recommendations (falling back to "similar") for an IMDb id. */
export async function moreLikeThis(imdbId: string, type: "movie" | "series"): Promise<Recommendation[]> {
  const found = await get<{ movie_results: TmdbItem[]; tv_results: TmdbItem[] }>(`/find/${encodeURIComponent(imdbId)}`, { external_source: "imdb_id" });
  const hit = type === "movie" ? found.movie_results[0] : found.tv_results[0];
  if (!hit) return [];
  const base = `/${tmdbPath(type)}/${hit.id}`;
  let r = await get<{ results: TmdbItem[] }>(`${base}/recommendations`);
  if (!r.results.length) r = await get<{ results: TmdbItem[] }>(`${base}/similar`);
  return mapResults(r.results, type).slice(0, 20);
}

/** The IMDb id for a TMDB title, needed to open it through the addons. */
export async function imdbIdFor(rec: Pick<Recommendation, "tmdbId" | "type">): Promise<string | null> {
  const r = await get<{ imdb_id?: string | null }>(`/${tmdbPath(rec.type)}/${rec.tmdbId}/external_ids`);
  return r.imdb_id && /^tt\d+$/.test(r.imdb_id) ? r.imdb_id : null;
}
