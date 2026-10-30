// Cloud sync and profiles.
//
// - account_data (one row per account): selected settings, shared by all profiles. Conflicts: last
//   write wins, comparing the server's updated_at with the time of the local edit. Its `addons`
//   column is the account-wide list used by early beta builds; it is only read to seed profiles that have none yet.
// - profile_data (one row per profile): the profile's library and its installed addons. The library
//   is merged entry by entry (newest addedAt/updatedAt wins, deletions are tombstones), so neither
//   side loses data. Addons are reconciled three-way against the list both sides last agreed on.
// - Each profile's Trakt and TMDB connections stay on this device (trakt.ts, tmdb.ts); they follow
//   the active owner published through owner.ts, as does the addon list (useAddons.ts).
// - The local "library" file is always the active owner's library and works offline. The "profile"
//   file remembers the last profile and caches each owner's library (the guest library included),
//   so switching profile or signing out never throws a library away.
//
// Everything that comes from the server is validated (shape, types, sizes) before it is used.

import { useEffect, useSyncExternalStore } from "react";
import { AVATAR_KEY, avatarOk, authedRequest, decodeJwt, getAccount, reauthenticate, signOut, subscribeAccount } from "./account";
import { DEFAULT_ADDONS, fetchManifest, storedGuestAddons, type Addon, type Manifest } from "./addons";
import {
  getLibrary, libraryRevision, progressKey, replaceLibrary, subscribeLibrary, type LibItem, type LibraryDoc, type Progress,
} from "./library";
import { sanitizeSettings, type Settings } from "./settings";
import { storeLoad, storeSave, uiLog } from "./tauri";
import { GUEST, emitProfileDeleted, setOwner } from "./owner";
import { fetchPinStatus } from "./pins";
import { onShutdown } from "./shutdown";
import { addonsUnavailable, getAddonsState, replaceAddons, setAddonsOwner, subscribeAddons } from "./useAddons";

// ---------------------------------------------------------------------------------------------
// Validation and merging (pure, unit tested)

export type Profile = { id: string; name: string; avatar: string; createdAt?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export { AVATAR_KEY };
export const MAX_PROFILES = 6;
const DAY = 86_400_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number, min = 0): string | undefined =>
  typeof v === "string" && v.length >= min && v.length <= max ? v : undefined;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100_000 ? v : undefined);
const img = (v: unknown): string | undefined => {
  const s = str(v, 2048);
  return s && /^(https?:\/\/|asset:\/\/)/i.test(s) ? s : undefined;
};
/** Timestamps from another device: never in the future (that would win every merge). */
const stamp = (v: unknown, now: number): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.min(n, now + DAY);
};

export function profileNameOk(name: string): boolean {
  const n = name.trim();
  return n.length >= 1 && n.length <= 32;
}

export function parseProfiles(x: unknown): Profile[] | null {
  if (!Array.isArray(x)) return null;
  const out: Profile[] = [];
  for (const r of x) {
    if (!isObj(r)) continue;
    const id = str(r.id, 36);
    const name = str(r.name, 64);
    const avatar = str(r.avatar, 512);
    if (!id || !UUID.test(id) || !name || !profileNameOk(name) || !avatar || !avatarOk(avatar)) continue;
    out.push({ id, name: name.trim(), avatar, ...(typeof r.created_at === "string" ? { createdAt: r.created_at.slice(0, 40) } : {}) });
  }
  return out.slice(0, MAX_PROFILES);
}

function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

export function validateLibItem(x: unknown, now = Date.now()): LibItem | null {
  if (!isObj(x)) return null;
  const id = str(x.id, 256, 1);
  const type = str(x.type, 32, 1);
  const name = str(x.name, 512);
  const addedAt = stamp(x.addedAt, now);
  if (!id || !type || name === undefined || addedAt === undefined) return null;
  return compact({ id, type, name, poster: img(x.poster), addedAt });
}

export function validateProgress(x: unknown, now = Date.now()): Progress | null {
  if (!isObj(x)) return null;
  const type = str(x.type, 32, 1);
  const videoId = str(x.videoId, 4096, 1);
  const metaId = str(x.metaId, 4096, 1);
  const name = str(x.name, 512);
  const position = num(x.position);
  const duration = num(x.duration);
  const updatedAt = stamp(x.updatedAt, now);
  if (!type || !videoId || !metaId || name === undefined || position === undefined || duration === undefined || updatedAt === undefined) return null;
  if (typeof x.watched !== "boolean") return null;
  const key = progressKey(type, videoId);
  if (x.key !== key) return null;
  return compact({
    key, metaId, type, name, videoId, position, duration, watched: x.watched, updatedAt,
    poster: img(x.poster), background: img(x.background), season: int(x.season), episode: int(x.episode),
    episodeTitle: str(x.episodeTitle, 512), source: str(x.source, 4096),
  });
}

export const LIMITS = { watchlist: 5000, progress: 20000, tombstones: 10000, libraryBytes: 900_000, addonsBytes: 240_000, settingsBytes: 60_000 };

/** Validates a library document from the server or disk. Invalid entries are dropped, not trusted. */
export function validateLibrary(x: unknown, now = Date.now()): LibraryDoc | null {
  if (!isObj(x) || !Array.isArray(x.watchlist) || !isObj(x.progress)) return null;
  const seen = new Set<string>();
  const watchlist: LibItem[] = [];
  for (const w of x.watchlist.slice(0, LIMITS.watchlist)) {
    const v = validateLibItem(w, now);
    if (v && !seen.has(v.id)) {
      seen.add(v.id);
      watchlist.push(v);
    }
  }
  const progress: Record<string, Progress> = {};
  let n = 0;
  for (const p of Object.values(x.progress)) {
    if (n >= LIMITS.progress) break;
    const v = validateProgress(p, now);
    if (v) {
      progress[v.key] = v;
      n++;
    }
  }
  const tombstones: Record<string, number> = {};
  if (isObj(x.tombstones)) {
    for (const [k, t] of Object.entries(x.tombstones).slice(0, LIMITS.tombstones)) {
      const ts = stamp(t, now);
      if (ts !== undefined && k.length <= 4200 && /^[wp]:/.test(k)) tombstones[k] = ts;
    }
  }
  // Old copies may still carry `collections` (a removed feature); they are ignored.
  return { watchlist, progress, tombstones };
}

function fill<T extends object>(newer: T, older: T): T {
  const out = { ...older } as Record<string, unknown>;
  for (const [k, v] of Object.entries(newer)) if (v !== undefined) out[k] = v;
  return out as T;
}

function mergeProgress(newer: Progress, older: Progress): Progress {
  const m = fill(newer, older);
  // An imported "watched" mark (Trakt) has no duration; keep the real one.
  if (!(newer.duration > 0) && older.duration > 0) {
    m.duration = older.duration;
    m.position = newer.watched ? older.duration : older.position;
  }
  return m;
}

/**
 * Merges two libraries entry by entry: the newest version of each entry wins (watchlist by
 * addedAt, progress by updatedAt), missing fields are filled from the other copy,
 * and an entry is removed only when a deletion tombstone is at least as new as it. Ties keep `a`.
 */
export function mergeLibraries(a: LibraryDoc, b: LibraryDoc, now = Date.now()): LibraryDoc {
  const tomb: Record<string, number> = { ...(a.tombstones ?? {}) };
  for (const [k, t] of Object.entries(b.tombstones ?? {})) if (!(tomb[k] >= t)) tomb[k] = t;

  const items = new Map<string, LibItem>();
  for (const w of [...a.watchlist, ...b.watchlist]) {
    const prev = items.get(w.id);
    if (!prev) items.set(w.id, w);
    else if (w.addedAt > prev.addedAt) items.set(w.id, fill(w, prev));
    else items.set(w.id, fill(prev, w));
  }
  const watchlist = [...items.values()].filter((w) => !(tomb[`w:${w.id}`] >= w.addedAt)).sort((x, y) => y.addedAt - x.addedAt);

  const progress: Record<string, Progress> = {};
  for (const p of [...Object.values(a.progress), ...Object.values(b.progress)]) {
    const prev = progress[p.key];
    progress[p.key] = !prev ? p : p.updatedAt > prev.updatedAt ? mergeProgress(p, prev) : mergeProgress(prev, p);
  }
  for (const k of Object.keys(progress)) if (tomb[`p:${k}`] >= progress[k].updatedAt) delete progress[k];

  // Tombstones only need to outlive the copies that could resurrect an entry.
  const tombstones = Object.fromEntries(
    Object.entries(tomb)
      .filter(([, t]) => now - t < 180 * DAY)
      .sort((x, y) => y[1] - x[1])
      .slice(0, LIMITS.tombstones),
  );
  return { watchlist, progress, tombstones };
}

/** Deterministic JSON (sorted keys) so equal libraries compare equal. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export const byteSize = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** Shrinks a library for upload: oldest finished history first, then old tombstones, then other history. The local copy is untouched. */
export function capLibrary(doc: LibraryDoc, maxBytes = LIMITS.libraryBytes): LibraryDoc {
  if (byteSize(doc) <= maxBytes) return doc;
  const entries = Object.values(doc.progress).sort((x, y) => Number(y.watched) - Number(x.watched) || x.updatedAt - y.updatedAt);
  let progress = entries;
  let tombs = Object.entries(doc.tombstones ?? {}).sort((x, y) => x[1] - y[1]);
  let watchlist = doc.watchlist;
  const build = (): LibraryDoc => ({
    watchlist, progress: Object.fromEntries(progress.map((p) => [p.key, p])), tombstones: Object.fromEntries(tombs),
  });
  let out = build();
  while (byteSize(out) > maxBytes) {
    if (progress.length > 0 && progress.some((p) => p.watched)) progress = progress.slice(Math.max(1, Math.ceil(progress.filter((p) => p.watched).length / 4)));
    else if (tombs.length > 0) tombs = tombs.slice(Math.max(1, Math.ceil(tombs.length / 2)));
    else if (progress.length > 0) progress = progress.slice(Math.max(1, Math.ceil(progress.length / 4)));
    else if (watchlist.length > 0) watchlist = watchlist.slice(0, Math.floor(watchlist.length * 0.75));
    else break;
    out = build();
  }
  return out;
}

/** Images served from this device (local-file thumbnails): `asset://…` on Linux, `http(s)://asset.localhost/…` on Windows. */
const deviceImage = (u: string | undefined) => !!u && /^(asset:|https?:\/\/asset\.localhost(?:[:/]|$))/i.test(u);

/**
 * The part of a library that may leave this device. Local files (their paths, names and
 * thumbnails) and the "last played source" of any entry stay local; they are kept in the
 * device's own library and merged back in on every sync.
 */
export function forCloud(doc: LibraryDoc): LibraryDoc {
  const watchlist = doc.watchlist
    .filter((w) => w.type !== "local")
    .map((w) => (deviceImage(w.poster) ? compact({ ...w, poster: undefined }) : w));
  const progress: Record<string, Progress> = {};
  for (const [k, p] of Object.entries(doc.progress)) {
    if (p.type === "local") continue;
    const clean = { ...p, source: undefined } as Progress;
    if (deviceImage(clean.poster)) clean.poster = undefined;
    if (deviceImage(clean.background)) clean.background = undefined;
    progress[k] = compact(clean);
  }
  const tombstones = Object.fromEntries(Object.entries(doc.tombstones ?? {}).filter(([k]) => !k.startsWith("p:local:")));
  return { watchlist, progress, tombstones };
}

export type SyncedAddon = { transportUrl: string; manifest?: Manifest };

function validManifest(m: unknown): m is Manifest {
  return (
    isObj(m) && typeof m.id === "string" && m.id.length <= 256 && typeof m.name === "string" && m.name.length <= 256 &&
    typeof m.version === "string" && Array.isArray(m.resources) && Array.isArray(m.types) && Array.isArray(m.catalogs)
  );
}

export function validateAddons(x: unknown): SyncedAddon[] | null {
  if (!Array.isArray(x)) return null;
  const out: SyncedAddon[] = [];
  const seen = new Set<string>();
  for (const a of x.slice(0, 100)) {
    if (!isObj(a)) continue;
    const url = str(a.transportUrl, 4096);
    if (!url || !/^https?:\/\/[^\s]+\/manifest\.json$/.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(validManifest(a.manifest) ? { transportUrl: url, manifest: a.manifest } : { transportUrl: url });
  }
  return out;
}

/** The settings that follow the account. Device-specific ones (volume, hardware decoding, UI scale, folders) stay local. */
export function pickSyncedSettings(s: Settings) {
  return {
    appearance: { theme: s.appearance.theme, reduceMotion: s.appearance.reduceMotion },
    subtitles: s.subtitles,
    playback: { resume: s.playback.resume, seekStep: s.playback.seekStep, audioLanguages: s.playback.audioLanguages, autoplayNext: s.playback.autoplayNext },
    library: { watchedThreshold: s.library.watchedThreshold },
  };
}

/** Applies synced settings from the server onto the local ones; unknown keys are ignored and values re-validated. */
export function applySyncedSettings(cur: Settings, remote: unknown): Settings {
  if (!isObj(remote)) return cur;
  const allowed = pickSyncedSettings(cur) as Record<string, Record<string, unknown>>;
  const next = structuredClone(cur) as unknown as Record<string, Record<string, unknown>>;
  for (const [section, keys] of Object.entries(allowed)) {
    const r = remote[section];
    if (!isObj(r)) continue;
    for (const k of Object.keys(keys)) if (k in r) next[section][k] = r[k];
  }
  return sanitizeSettings(next);
}

// ---------------------------------------------------------------------------------------------
// Persistent state ("profile" store)

type ProfileDoc = {
  v: 1;
  userId?: string;
  profileId?: string;
  /** Whose library the "library" file currently holds: "guest" or a profile id. */
  owner: string;
  profiles?: Profile[];
  guest?: LibraryDoc;
  caches: Record<string, { userId: string; lib: LibraryDoc }>;
  /** Accounts whose first profile on this device already received the guest library. */
  merged: string[];
  accountSeen: Record<string, string>;
  accountDirtyAt?: number;
  lastSync?: number;
  /** Each profile's addon list on this device, and `base`: the URL list last agreed with the server. */
  addons: Record<string, AddonCache>;
  /** Which profiles have a PIN (cached so a locked profile stays locked offline). */
  pins: Record<string, boolean>;
};
type AddonCache = { userId: string; list: SyncedAddon[]; base?: string; dirtyAt?: number };

let pdoc: ProfileDoc = { v: 1, owner: "guest", caches: {}, merged: [], accountSeen: {}, addons: {}, pins: {} };
let pdocTimer: ReturnType<typeof setTimeout> | undefined;
function savePdoc(now = false) {
  clearTimeout(pdocTimer);
  pdocTimer = undefined;
  if (now) return storeSave("profile", pdoc).catch(() => {});
  pdocTimer = setTimeout(() => {
    pdocTimer = undefined;
    void storeSave("profile", pdoc).catch(() => {});
  }, 1000);
  return Promise.resolve();
}
// Only a pending save is flushed: before initSync has loaded the file there is nothing to write.
onShutdown(() => (pdocTimer !== undefined ? savePdoc(true) : undefined));

function parsePdoc(x: unknown): ProfileDoc {
  const d: ProfileDoc = { v: 1, owner: "guest", caches: {}, merged: [], accountSeen: {}, addons: {}, pins: {} };
  if (!isObj(x)) return d;
  if (typeof x.userId === "string" && UUID.test(x.userId)) d.userId = x.userId;
  if (typeof x.profileId === "string" && UUID.test(x.profileId)) d.profileId = x.profileId;
  if (typeof x.owner === "string" && (x.owner === "guest" || UUID.test(x.owner))) d.owner = x.owner;
  d.profiles = parseProfiles(x.profiles) ?? undefined;
  const g = validateLibrary(x.guest);
  if (g) d.guest = g;
  if (isObj(x.caches)) {
    for (const [id, c] of Object.entries(x.caches)) {
      if (!UUID.test(id) || !isObj(c) || typeof c.userId !== "string") continue;
      const lib = validateLibrary(c.lib);
      if (lib) d.caches[id] = { userId: c.userId, lib };
    }
  }
  if (Array.isArray(x.merged)) d.merged = x.merged.filter((u): u is string => typeof u === "string" && UUID.test(u));
  if (isObj(x.accountSeen)) for (const [u, t] of Object.entries(x.accountSeen)) if (UUID.test(u) && typeof t === "string") d.accountSeen[u] = t.slice(0, 40);
  d.accountDirtyAt = num(x.accountDirtyAt);
  d.lastSync = num(x.lastSync);
  if (isObj(x.addons)) {
    for (const [id, c] of Object.entries(x.addons)) {
      if (!UUID.test(id) || !isObj(c) || typeof c.userId !== "string") continue;
      const list = validateAddons(c.list);
      if (list) d.addons[id] = compact({ userId: c.userId, list, base: str(c.base, 500_000), dirtyAt: num(c.dirtyAt) });
    }
  }
  if (isObj(x.pins)) for (const [id, v] of Object.entries(x.pins)) if (UUID.test(id) && v === true) d.pins[id] = true;
  return d;
}

/** Exposed for tests: parses a "profile" store document. */
export const parseProfileStore = parsePdoc;

// ---------------------------------------------------------------------------------------------
// Observable state

export type SyncState = {
  profiles: Profile[];
  profilesLoaded: boolean;
  active: Profile | null;
  busy: boolean;
  lastSync: number | null;
  error: string | null;
  /** Profiles that have a PIN. */
  pins: Record<string, boolean>;
  /** A profile whose PIN pad the picker should open by itself (the last profile, at launch). */
  pinPrompt: string | null;
};

let state: SyncState = { profiles: [], profilesLoaded: false, active: null, busy: false, lastSync: null, error: null, pins: {}, pinPrompt: null };
/** Whether the active profile was opened with its PIN (or the server had just said it has none). */
let activeVerified = false;
/** Whether `state.pins` came from the server in this session (not only from the offline cache). */
let pinsFresh = false;
const subs = new Set<() => void>();
function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export const getSync = () => state;
export function useSync(): SyncState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}

const signedInUser = (): string | null => {
  const a = getAccount();
  return a.status === "signedIn" ? a.userId : null;
};

// One operation at a time (switches, syncs) so they never interleave.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

function syncError(e: unknown): string {
  return e instanceof Error && e.message.length < 200 ? e.message : "Couldn't sync. Kinly will try again later.";
}

class CloudError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function rest(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}) {
  const r = await authedRequest(`/rest/v1/${path}`, {
    method: init.method,
    body: init.body,
    headers: init.prefer ? { Prefer: init.prefer } : undefined,
  });
  if (r.status < 200 || r.status >= 300) {
    void uiLog("warn", `sync: ${path.split("?")[0]} HTTP ${r.status}`);
    throw new CloudError(r.status === 401 || r.status === 403 ? "Not authorised. Sign in again." : `Cloud request failed (HTTP ${r.status}).`, r.status);
  }
  if (!r.body) return null;
  try {
    return JSON.parse(r.body) as unknown;
  } catch {
    throw new Error("Unexpected response from the cloud.");
  }
}

// ---------------------------------------------------------------------------------------------
// Profiles

export async function refreshProfiles(): Promise<Profile[]> {
  const uid = signedInUser();
  if (!uid) return [];
  try {
    const rows = parseProfiles(await rest("profiles?select=id,name,avatar,created_at&order=created_at.asc"));
    if (!rows) throw new Error("Unexpected response from the cloud.");
    if (signedInUser() !== uid) return [];
    pdoc.profiles = rows;
    void savePdoc();
    const active = state.active ? rows.find((p) => p.id === state.active!.id) ?? null : null;
    setState({ profiles: rows, profilesLoaded: true, active, error: null });
    await refreshPins().catch(() => {});
    return rows;
  } catch (e) {
    setState({ profilesLoaded: true, error: syncError(e) });
    throw e;
  }
}

/** The account's primary profile: its oldest one (the list is ordered by created_at). */
export const primaryProfile = (): Profile | null => state.profiles[0] ?? null;

/** Fetches which profiles have a PIN, and locks the active profile if it gained one elsewhere. */
export async function refreshPins(): Promise<void> {
  const uid = signedInUser();
  if (!uid) return;
  const pins = await fetchPinStatus();
  if (signedInUser() !== uid) return;
  pinsFresh = true;
  applyPins(Object.fromEntries(Object.entries(pins).filter(([, v]) => v)));
}

function applyPins(pins: Record<string, boolean>) {
  pdoc.pins = pins;
  void savePdoc();
  setState({ pins });
  const active = state.active;
  if (active && pins[active.id] && !activeVerified) {
    // Opened from a stale "no PIN" cache: ask for the PIN now. The library stays loaded underneath.
    setState({ active: null, pinPrompt: active.id });
  } else if (!active && state.pinPrompt && !pins[state.pinPrompt]) {
    // The last profile's PIN was removed elsewhere: open it as before.
    const last = state.profiles.find((p) => p.id === state.pinPrompt);
    setState({ pinPrompt: null });
    if (last) void selectProfile(last).catch(() => {});
  }
}

/** Records a PIN change made on this device (Edit profile). */
export function notePinChanged(profileId: string, hasPin: boolean) {
  const pins = { ...state.pins };
  if (hasPin) pins[profileId] = true;
  else delete pins[profileId];
  if (state.active?.id === profileId) activeVerified = true;
  applyPins(pins);
}

/** Closes the picker's automatic PIN pad (the user chose "back"). */
export const clearPinPrompt = () => state.pinPrompt && setState({ pinPrompt: null });

const urlsJson = (list: { transportUrl: string }[]) => stableJson(list.map((a) => a.transportUrl));

/** Manifests for default addons, taken from any list already on this device (no network). */
function knownManifest(url: string): Manifest | undefined {
  const fromState = getAddonsState().addons.find((a) => a.transportUrl === url)?.manifest;
  if (fromState) return fromState;
  for (const c of Object.values(pdoc.addons)) {
    const m = c.list.find((a) => a.transportUrl === url && a.manifest)?.manifest;
    if (m) return m;
  }
  return undefined;
}

/** The default addons (Cinemeta + OpenSubtitles), with manifests when this device already has them. */
export function defaultAddonList(): SyncedAddon[] {
  return DEFAULT_ADDONS.map((transportUrl) => compact({ transportUrl, manifest: knownManifest(transportUrl) }));
}

/** The addons a new profile starts with when nothing else applies: the beta-era account list, guest list, defaults. */
async function seedAddons(): Promise<SyncedAddon[]> {
  const rows = await rest("account_data?select=addons");
  const legacy = Array.isArray(rows) && isObj(rows[0]) ? validateAddons(rows[0].addons) : null;
  if (legacy?.length) return legacy;
  const guest = await storedGuestAddons();
  if (guest.length) return guest.map((a) => ({ transportUrl: a.transportUrl, manifest: a.manifest }));
  return defaultAddonList();
}

/** A profile's current addon list (for "Copy addons from …"). */
async function addonsOfProfile(id: string): Promise<SyncedAddon[]> {
  const cached = pdoc.addons[id];
  if (state.active?.id === id && cached) return cached.list;
  const rows = await rest(`profile_data?profile_id=eq.${id}&select=addons`);
  const remote = Array.isArray(rows) && isObj(rows[0]) && rows[0].addons != null ? validateAddons(rows[0].addons) : null;
  if (remote) return remote.map((r) => (r.manifest ? r : compact({ transportUrl: r.transportUrl, manifest: cached?.list.find((c) => c.transportUrl === r.transportUrl)?.manifest })));
  return cached?.list ?? (await seedAddons());
}

export type CreateProfileOptions = { copyAddonsFrom?: string | null };

/**
 * Creates a profile. Its addon list is written right away: a copy of `copyAddonsFrom`'s list, or
 * the default addons. (Copying Trakt/TMDB connections is local; see copyTraktConnection and
 * copyTmdbConnection.)
 */
export async function createProfile(name: string, avatar: string, opts: CreateProfileOptions = {}): Promise<Profile> {
  if (!profileNameOk(name)) throw new Error("Names are 1 to 32 characters.");
  if (!avatarOk(avatar)) throw new Error("Choose an avatar or a valid image link.");
  if (state.profiles.length >= MAX_PROFILES) throw new Error(`An account can have up to ${MAX_PROFILES} profiles.`);
  const uid = signedInUser();
  if (!uid) throw new Error("Not signed in.");
  let list: SyncedAddon[];
  try {
    list = opts.copyAddonsFrom && UUID.test(opts.copyAddonsFrom) ? await addonsOfProfile(opts.copyAddonsFrom) : defaultAddonList();
  } catch {
    if (opts.copyAddonsFrom) throw new Error("Couldn't read the addons to copy. Check your connection and try again.");
    list = defaultAddonList();
  }
  const rows = parseProfiles(await rest("profiles?select=id,name,avatar,created_at", { method: "POST", body: { name: name.trim(), avatar }, prefer: "return=representation" }));
  if (!rows?.[0]) throw new Error("Unexpected response from the cloud.");
  const created = rows[0];
  setState({ profiles: [...state.profiles, created] });
  pdoc.profiles = state.profiles;
  pdoc.addons[created.id] = { userId: uid, list };
  try {
    await rest("profile_data?on_conflict=profile_id", {
      method: "POST",
      body: { profile_id: created.id, user_id: uid, addons: addonsPayload(list) },
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    pdoc.addons[created.id].base = urlsJson(list);
  } catch {
    // Uploaded on the profile's first sync instead (an unseeded profile takes its offline copy).
  }
  void savePdoc();
  return created;
}

export async function updateProfile(id: string, name: string, avatar: string): Promise<void> {
  if (!UUID.test(id)) throw new Error("Unknown profile.");
  if (!profileNameOk(name)) throw new Error("Names are 1 to 32 characters.");
  if (!avatarOk(avatar)) throw new Error("Choose an avatar or a valid image link.");
  const body = { name: name.trim(), avatar };
  let rows: Profile[] | null;
  try {
    rows = parseProfiles(await rest(`profiles?id=eq.${id}&select=id,name,avatar,created_at`, { method: "PATCH", body, prefer: "return=representation" }));
  } catch (e) {
    // Older backends only allow GET/POST/PUT/DELETE; an upsert updates the same row.
    if (!String(e).includes("unsupported method")) throw e;
    rows = parseProfiles(
      await rest("profiles?on_conflict=id&select=id,name,avatar,created_at", { method: "POST", body: { id, ...body }, prefer: "resolution=merge-duplicates,return=representation" }),
    );
  }
  const row = rows?.find((p) => p.id === id);
  if (!row) throw new Error("Couldn't save the profile.");
  const profiles = state.profiles.map((p) => (p.id === id ? row : p));
  setState({ profiles, active: state.active?.id === id ? row : state.active });
  pdoc.profiles = profiles;
  void savePdoc();
}

/** Deletes a profile and (by cascade) its cloud library. Its local cached copy is removed too. */
export async function deleteProfile(id: string): Promise<void> {
  if (!UUID.test(id)) throw new Error("Unknown profile.");
  await rest(`profiles?id=eq.${id}`, { method: "DELETE" });
  emitProfileDeleted(id);
  return serial(async () => {
    const profiles = state.profiles.filter((p) => p.id !== id);
    delete pdoc.caches[id];
    delete pdoc.addons[id];
    if (pdoc.pins[id]) {
      pdoc.pins = { ...pdoc.pins };
      delete pdoc.pins[id];
      setState({ pins: pdoc.pins });
    }
    pdoc.profiles = profiles;
    if (pdoc.profileId === id) pdoc.profileId = undefined;
    if (state.active?.id === id) {
      setState({ profiles, active: null });
      await switchOwner("guest", { discardCurrent: true });
    } else setState({ profiles });
    await savePdoc(true);
  });
}

export class PinRequiredError extends Error {
  constructor() {
    super("Enter this profile's PIN to open it.");
  }
}

/**
 * Makes `profile` the active one: saves the current library first, loads the profile's, then syncs.
 * A profile with a PIN only opens with `pinVerified` (after verifyPin answered "ok").
 */
export function selectProfile(profile: Profile, opts: { pinVerified?: boolean } = {}): Promise<void> {
  const uid = signedInUser();
  if (!uid) return Promise.resolve();
  const needsPin = () => state.pins[profile.id] && !opts.pinVerified && state.active?.id !== profile.id;
  if (needsPin()) return Promise.reject(new PinRequiredError());
  return serial(async () => {
    // The PIN status may have arrived while this waited in the queue.
    if (needsPin()) throw new PinRequiredError();
    if (state.active?.id !== profile.id && state.active) await pushLibraryNow().catch(() => {});
    if (state.active?.id !== profile.id) activeVerified = !!opts.pinVerified || (pinsFresh && !state.pins[profile.id]);
    setState({ active: profile, pinPrompt: null });
    pdoc.userId = uid;
    pdoc.profileId = profile.id;
    await switchOwner(profile.id);
    await savePdoc(true);
  }).then(() => syncNow());
}

/** Swaps the "library" file to another owner's copy. The outgoing library is cached first. */
async function switchOwner(next: string, opts: { discardCurrent?: boolean } = {}) {
  const prev = pdoc.owner;
  const uid = signedInUser() ?? pdoc.userId ?? "";
  if (prev === next) return;
  const current = getLibrary();
  if (!opts.discardCurrent) {
    if (prev === "guest") pdoc.guest = current;
    else pdoc.caches[prev] = { userId: pdoc.caches[prev]?.userId ?? uid, lib: current };
  }
  let lib: LibraryDoc = next === "guest" ? (pdoc.guest ?? emptyLibrary()) : (pdoc.caches[next]?.lib ?? emptyLibrary());
  if (next !== "guest" && uid && !pdoc.merged.includes(uid)) {
    // First profile used by this account on this device: bring the guest library along.
    lib = mergeLibraries(lib, pdoc.guest ?? (prev === "guest" ? current : emptyLibrary()));
    pdoc.merged = [...pdoc.merged, uid];
  }
  if (next !== "guest") delete pdoc.caches[next];
  pdoc.owner = next;
  applyLibrary(lib);
  activateOwner(next);
  await savePdoc(true);
}

/** Points the per-owner modules (Trakt, TMDB, addons) at `owner`. */
function activateOwner(owner: string) {
  setOwner(owner);
  if (owner === GUEST) {
    void setAddonsOwner(GUEST, null);
    return;
  }
  const cache = pdoc.addons[owner];
  const ready = cache ? cache.list.filter((a): a is Addon => !!a.manifest) : null;
  applyingAddons = true;
  try {
    void setAddonsOwner(owner, ready);
  } finally {
    applyingAddons = false;
  }
  if (cache && ready && ready.length < cache.list.length) void resolveCachedAddons(owner);
}

/** Fetches manifests missing from a profile's offline list, then shows the complete list. */
async function resolveCachedAddons(owner: string) {
  const cache = pdoc.addons[owner];
  if (!cache) return;
  const out = await resolveManifests(cache.list);
  if (pdoc.addons[owner] !== cache || getAddonsState().owner !== owner) return;
  cache.list = cache.list.map((a) => out.find((o) => o.transportUrl === a.transportUrl) ?? a);
  applyingAddons = true;
  try {
    await replaceAddons(out, owner);
  } finally {
    applyingAddons = false;
  }
}

const emptyLibrary = (): LibraryDoc => ({ watchlist: [], progress: {}, tombstones: {} });

// ---------------------------------------------------------------------------------------------
// Library sync

let appliedRevision = -1;
let libTimer: ReturnType<typeof setTimeout> | undefined;

let applying = false;
function applyLibrary(lib: LibraryDoc) {
  applying = true;
  try {
    replaceLibrary(lib);
  } finally {
    applying = false;
  }
  appliedRevision = libraryRevision();
}

/** Merges entries (e.g. imported from Trakt) into the active library. Counts as a local change. */
export function importIntoLibrary(part: LibraryDoc): number {
  const before = getLibrary();
  const merged = mergeLibraries(before, part);
  if (stableJson(merged) === stableJson(before)) return 0;
  replaceLibrary(merged);
  return 1;
}

/**
 * Writes a row only if it is still the version this device read (`seenAt` = its updated_at; null
 * = there was no row). Returns the row's new updated_at ("" if not reported), or null when another
 * device wrote in between: the caller then reads and merges again instead of overwriting newer data.
 */
export async function writeIfUnchanged(table: string, match: string, seenAt: string | null, body: Record<string, unknown>): Promise<string | null> {
  const at = (rows: unknown) => {
    const r0 = Array.isArray(rows) && isObj(rows[0]) ? rows[0] : null;
    return r0 && typeof r0.updated_at === "string" ? r0.updated_at.slice(0, 40) : "";
  };
  if (seenAt) {
    const rows = await rest(`${table}?${match}&updated_at=eq.${encodeURIComponent(seenAt)}&select=updated_at`, { method: "PATCH", body, prefer: "return=representation" });
    return Array.isArray(rows) && rows.length > 0 ? at(rows) : null;
  }
  try {
    return at(await rest(`${table}?select=updated_at`, { method: "POST", body, prefer: "return=representation" }));
  } catch (e) {
    if (e instanceof CloudError && e.status === 409) return null;
    throw e;
  }
}

const SYNC_ATTEMPTS = 3;
const conflictError = () => new Error("The cloud copy kept changing. Kinly will try again later.");

/** Syncs the active profile's row: its library (merged) and its addon list (reconciled). */
async function syncLibrary(): Promise<void> {
  for (let i = 0; i < SYNC_ATTEMPTS; i++) if (await syncLibraryOnce()) return;
  throw conflictError();
}

/** One read-merge-write round. False when the row changed on the server meanwhile. */
async function syncLibraryOnce(): Promise<boolean> {
  const uid = signedInUser();
  const profile = state.active;
  if (!uid || !profile || pdoc.owner !== profile.id) return true;
  let rows: unknown;
  try {
    rows = await rest(`profile_data?profile_id=eq.${profile.id}&select=library,addons,updated_at`);
  } catch (e) {
    addonsUnavailable(profile.id);
    throw e;
  }
  const row = Array.isArray(rows) && isObj(rows[0]) ? rows[0] : null;
  const remote = row ? validateLibrary(row.library) : null;
  // null: this profile has no list of its own yet (created by an early beta build, or never synced).
  const remoteAddons = row && row.addons != null ? validateAddons(row.addons) : null;
  const remoteAt = row && typeof row.updated_at === "string" ? row.updated_at.slice(0, 40) : null;
  if (state.active?.id !== profile.id) return true;
  const local = getLibrary();
  // Copies uploaded by older versions may hold another device's local files: those are not
  // merged in, and the cleaned copy below replaces them on the server.
  const merged = remote ? mergeLibraries(local, forCloud(remote)) : local;
  if (stableJson(merged) !== stableJson(local)) applyLibrary(merged);
  else appliedRevision = libraryRevision();
  const body: Record<string, unknown> = { profile_id: profile.id, user_id: uid };
  const shared = forCloud(merged);
  if (!remote || stableJson(shared) !== stableJson(remote)) body.library = capLibrary(shared);
  let upload: SyncedAddon[] | null;
  try {
    upload = await reconcileAddons(profile.id, uid, remoteAddons, remoteAt);
  } catch (e) {
    addonsUnavailable(profile.id);
    throw e;
  }
  if (state.active?.id !== profile.id) return true;
  if (upload) body.addons = addonsPayload(upload);
  if (body.library || body.addons) {
    if ((await writeIfUnchanged("profile_data", `profile_id=eq.${profile.id}`, row ? remoteAt : null, body)) === null) return false;
  }
  if (upload && pdoc.addons[profile.id]) {
    pdoc.addons[profile.id].base = urlsJson(upload);
    pdoc.addons[profile.id].dirtyAt = undefined;
    void savePdoc();
  }
  return true;
}

export type AddonDecision = { take: "local" | "remote" | "seed" | "same" };

/**
 * Three-way decision for a profile's addon list (pure; unit tested). `base` is the URL list both
 * sides last agreed on, `remote` null means the profile has no list on the server yet.
 */
export function decideAddons(p: { local: string | null; remote: string | null; base: string | undefined; dirtyAt?: number; remoteAt?: string | null }): AddonDecision["take"] {
  if (p.remote === null) return p.local === null ? "seed" : "local";
  if (p.local === null || p.base === undefined) return p.local === p.remote ? "same" : "remote";
  if (p.local === p.remote) return "same";
  if (p.remote === p.base) return "local";
  if (p.local === p.base) return "remote";
  const remoteMs = p.remoteAt ? Date.parse(p.remoteAt) : 0;
  return p.dirtyAt && p.dirtyAt > remoteMs ? "local" : "remote";
}

/** Brings the profile's local and server addon lists together. Returns the list to upload, if any. */
async function reconcileAddons(id: string, uid: string, remote: SyncedAddon[] | null, remoteAt: string | null): Promise<SyncedAddon[] | null> {
  const cache = pdoc.addons[id];
  const take = decideAddons({
    local: cache ? urlsJson(cache.list) : null,
    remote: remote ? urlsJson(remote) : null,
    base: cache?.base,
    dirtyAt: cache?.dirtyAt,
    remoteAt,
  });
  if (take === "same") {
    cache!.base = urlsJson(cache!.list);
    if (remote && remote.some((r) => r.manifest && !cache!.list.find((c) => c.transportUrl === r.transportUrl)?.manifest)) await applyAddons(id, uid, remote);
    void savePdoc();
    return null;
  }
  if (take === "local") return cache!.list;
  if (take === "remote") {
    await applyAddons(id, uid, remote!);
    return null;
  }
  const seed = await seedAddons();
  await applyAddons(id, uid, seed);
  return seed;
}

/** Makes `list` profile `id`'s addon list on this device (offline copy, and the live list if active). */
async function applyAddons(id: string, uid: string, list: SyncedAddon[]) {
  const prev = pdoc.addons[id];
  const known = new Map<string, Manifest>();
  for (const a of prev?.list ?? []) if (a.manifest) known.set(a.transportUrl, a.manifest);
  const withKnown = list.map((a) => (a.manifest || !known.has(a.transportUrl) ? a : { transportUrl: a.transportUrl, manifest: known.get(a.transportUrl) }));
  const cache: AddonCache = { userId: uid, list: withKnown, base: urlsJson(withKnown) };
  pdoc.addons[id] = cache;
  void savePdoc();
  if (getAddonsState().owner !== id) return;
  const out = await resolveManifests(withKnown);
  if (pdoc.addons[id] !== cache) return;
  cache.list = withKnown.map((a) => out.find((o) => o.transportUrl === a.transportUrl) ?? a);
  applyingAddons = true;
  try {
    await replaceAddons(out, id);
  } finally {
    applyingAddons = false;
  }
}

/** The installable list: each entry's manifest, fetched when missing. Unreachable addons are left out. */
async function resolveManifests(list: SyncedAddon[]): Promise<Addon[]> {
  const local = new Map(getAddonsState().addons.map((a) => [a.transportUrl, a]));
  const out: Addon[] = [];
  for (const r of list) {
    const manifest = r.manifest ?? local.get(r.transportUrl)?.manifest ?? knownManifest(r.transportUrl) ?? (await fetchManifest(r.transportUrl).catch(() => null));
    if (manifest) out.push({ transportUrl: r.transportUrl, manifest });
  }
  return out;
}

function pushLibraryNow(): Promise<void> {
  clearTimeout(libTimer);
  return syncLibrary();
}

function onLibraryChange() {
  if (applying || libraryRevision() === appliedRevision) return;
  if (!signedInUser() || !state.active) return;
  clearTimeout(libTimer);
  libTimer = setTimeout(() => void serial(() => runSync(syncLibrary)), 3000);
}

// ---------------------------------------------------------------------------------------------
// Account data sync (settings) and the active profile's addon list

let settingsBridge: { get: () => Settings; apply: (remote: unknown) => void } | null = null;
let lastSettingsJson: string | null = null;
let accTimer: ReturnType<typeof setTimeout> | undefined;
let applyingAddons = false;

/** Runs an account sync soon (used once the settings bridge is ready). */
function kickAccountSync() {
  if (!signedInUser() || !state.active) return;
  clearTimeout(accTimer);
  accTimer = setTimeout(() => void serial(() => runSync(syncAccount)), 500);
}

function markAccountDirty() {
  pdoc.accountDirtyAt = Date.now();
  void savePdoc();
  if (!signedInUser()) return;
  clearTimeout(accTimer);
  accTimer = setTimeout(() => void serial(() => runSync(syncAccount)), 3000);
}

/** The user installed, removed or reordered an addon in a profile: update its offline copy and upload. */
function onAddonsChange() {
  const s = getAddonsState();
  if (applyingAddons || s.status !== "ready" || !s.owner || s.owner === GUEST) return;
  const id = s.owner;
  const prev = pdoc.addons[id];
  const uid = prev?.userId ?? signedInUser() ?? pdoc.userId ?? "";
  // Entries whose manifest couldn't be fetched aren't shown, so they can't have been removed: keep them.
  const shown = new Set(s.addons.map((a) => a.transportUrl));
  const hidden = (prev?.list ?? []).filter((a) => !a.manifest && !shown.has(a.transportUrl));
  const list: SyncedAddon[] = [...s.addons.map((a) => ({ transportUrl: a.transportUrl, manifest: a.manifest })), ...hidden];
  const changed = !prev || urlsJson(prev.list) !== urlsJson(list);
  pdoc.addons[id] = compact({ userId: uid, list, base: prev?.base, dirtyAt: changed ? Date.now() : prev?.dirtyAt });
  void savePdoc();
  if (changed && signedInUser() && state.active?.id === id) {
    clearTimeout(libTimer);
    libTimer = setTimeout(() => void serial(() => runSync(syncLibrary)), 3000);
  }
}

function addonsPayload(addons: SyncedAddon[]): SyncedAddon[] {
  const full = addons.map((a) => compact({ transportUrl: a.transportUrl, manifest: a.manifest }));
  return byteSize(full) <= LIMITS.addonsBytes ? full : addons.map((a) => ({ transportUrl: a.transportUrl }));
}

async function syncAccount(): Promise<void> {
  for (let i = 0; i < SYNC_ATTEMPTS; i++) if (await syncAccountOnce()) return;
  throw conflictError();
}

async function syncAccountOnce(): Promise<boolean> {
  const uid = signedInUser();
  if (!uid || !settingsBridge) return true;
  const rows = await rest("account_data?select=settings,updated_at");
  const row = Array.isArray(rows) && isObj(rows[0]) ? rows[0] : null;
  if (signedInUser() !== uid) return true;
  const remoteSettings = row && isObj(row.settings) && Object.keys(row.settings).length > 0 && byteSize(row.settings) <= 65_536 ? row.settings : null;
  const remoteAt = row && typeof row.updated_at === "string" ? row.updated_at.slice(0, 40) : null;
  const seen = pdoc.accountSeen[uid];
  const dirtyAt = pdoc.accountDirtyAt;

  let upload = false;
  if (!row) upload = true;
  else if (!seen) {
    // First sync of this account on this device: take the account's settings.
    if (remoteSettings) settingsBridge.apply(remoteSettings);
    else upload = true;
  } else if (remoteAt !== seen) {
    const remoteMs = remoteAt ? Date.parse(remoteAt) : 0;
    if (dirtyAt && dirtyAt > remoteMs) upload = true;
    else if (remoteSettings) settingsBridge.apply(remoteSettings);
  } else if (dirtyAt) upload = true;

  let newSeen = remoteAt;
  if (upload) {
    const settings = pickSyncedSettings(settingsBridge.get());
    const body: Record<string, unknown> = { user_id: uid, settings: byteSize(settings) <= LIMITS.settingsBytes ? settings : {} };
    const written = await writeIfUnchanged("account_data", `user_id=eq.${uid}`, row ? remoteAt : null, body);
    if (written === null) return false;
    newSeen = written || newSeen;
  }
  if (newSeen) pdoc.accountSeen[uid] = newSeen;
  // A change made while this round was on the network is newer than what it sent: keep it dirty.
  if (pdoc.accountDirtyAt === dirtyAt) pdoc.accountDirtyAt = undefined;
  void savePdoc();
  return true;
}

/** Keeps the account-level settings in sync. Call once inside <AppProvider> (main.tsx does). */
export function useCloudSettings(settings: Settings, update: (fn: (s: Settings) => Settings) => void) {
  useEffect(() => {
    settingsBridge = {
      get: () => latestSettings!,
      apply: (remote) => {
        const next = applySyncedSettings(latestSettings!, remote);
        lastSettingsJson = stableJson(pickSyncedSettings(next));
        update((cur) => applySyncedSettings(cur, remote));
      },
    };
    kickAccountSync();
    return () => {
      settingsBridge = null;
    };
  }, [update]);
  useEffect(() => {
    latestSettings = settings;
    const json = stableJson(pickSyncedSettings(settings));
    if (lastSettingsJson === null) lastSettingsJson = json;
    else if (json !== lastSettingsJson) {
      lastSettingsJson = json;
      markAccountDirty();
    }
  }, [settings]);
}
let latestSettings: Settings | null = null;

// ---------------------------------------------------------------------------------------------
// Orchestration

async function runSync(fn: () => Promise<void>) {
  if (!signedInUser()) return;
  setState({ busy: true });
  try {
    await fn();
    pdoc.lastSync = Date.now();
    void savePdoc();
    setState({ busy: false, error: null, lastSync: pdoc.lastSync });
  } catch (e) {
    setState({ busy: false, error: syncError(e) });
  }
}

/** Pulls and pushes everything now (account data, then the active profile's library). */
export function syncNow(): Promise<void> {
  clearTimeout(libTimer);
  clearTimeout(accTimer);
  return serial(() =>
    runSync(async () => {
      await syncAccount();
      await syncLibrary();
    }),
  );
}

/** Deletes every profile (and their libraries) and empties the account's synced addons/settings, then signs out. */
export async function deleteAllCloudData(): Promise<void> {
  const uid = signedInUser();
  if (!uid) return;
  await rest(`profiles?user_id=eq.${uid}`, { method: "DELETE" });
  await rest("account_data?on_conflict=user_id", { method: "POST", body: { user_id: uid, addons: [], settings: {} }, prefer: "resolution=merge-duplicates,return=minimal" });
  await forgetAccountLocally(uid);
}

/**
 * Permanently deletes the signed-in account and everything stored with it on the server
 * (profiles, libraries, addons, settings, PINs), after checking the password. This device's
 * copies of the account's data are removed too; files on disk and the guest library stay.
 */
export async function deleteAccount(password: string): Promise<void> {
  const uid = signedInUser();
  if (!uid) throw new Error("Not signed in.");
  // The server only deletes after a password sign-in in the last few minutes.
  await reauthenticate(password);
  clearTimeout(libTimer);
  clearTimeout(accTimer);
  const r = await rest("rpc/delete_my_account", { method: "POST", body: {} });
  if (r !== "ok") throw new Error(r === "reauth" ? "Please confirm your password again." : "Couldn't delete the account. Try again later.");
  await forgetAccountLocally(uid);
  await signOut();
}

/** Removes this device's copies of an account's profiles, libraries, addons and PIN flags. */
async function forgetAccountLocally(uid: string): Promise<void> {
  await serial(async () => {
    for (const p of state.profiles) emitProfileDeleted(p.id);
    for (const [id, c] of Object.entries(pdoc.caches)) if (c.userId === uid) delete pdoc.caches[id];
    for (const [id, c] of Object.entries(pdoc.addons)) if (c.userId === uid) delete pdoc.addons[id];
    for (const p of state.profiles) delete pdoc.pins[p.id];
    const wasOwner = pdoc.owner !== "guest";
    pdoc.merged = pdoc.merged.filter((u) => u !== uid);
    delete pdoc.accountSeen[uid];
    pdoc.profiles = [];
    pdoc.profileId = undefined;
    setState({ profiles: [], active: null });
    if (wasOwner) await switchOwner("guest", { discardCurrent: true });
    await savePdoc(true);
  });
}

/** Uploads pending changes (best effort, bounded wait) and then signs out. */
export async function syncAndSignOut(): Promise<void> {
  if (signedInUser() && state.active) {
    await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 8000))]);
  }
  await signOut();
}

let handledUser: string | null | undefined;

function onAccountChange() {
  const a = getAccount();
  if (a.status === "loading") return;
  const uid = a.status === "signedIn" ? a.userId : null;
  if (uid === handledUser) return;
  handledUser = uid;
  if (uid) {
    const cached = pdoc.userId === uid ? (pdoc.profiles ?? []) : [];
    const last = pdoc.userId === uid ? cached.find((p) => p.id === pdoc.profileId) : undefined;
    const pins = pdoc.userId === uid ? pdoc.pins : {};
    activeVerified = false;
    pinsFresh = false;
    setState({ profiles: cached, profilesLoaded: cached.length > 0, active: null, error: null, lastSync: pdoc.lastSync ?? null, pins, pinPrompt: null });
    // The last profile opens by itself, unless it has a PIN: then the picker asks for it first.
    if (last && pins[last.id]) setState({ pinPrompt: last.id });
    else if (last) {
      void selectProfile(last).catch((e) => {
        if (e instanceof PinRequiredError && !state.active && signedInUser() === uid) setState({ pinPrompt: last.id });
      });
    }
    void refreshProfiles().catch(() => {});
  } else {
    clearTimeout(libTimer);
    clearTimeout(accTimer);
    activeVerified = false;
    pinsFresh = false;
    setState({ profiles: [], profilesLoaded: false, active: null, busy: false, error: null, pins: {}, pinPrompt: null });
    void serial(() => switchOwner("guest"));
  }
}

let started = false;
/** Call after loadLibrary() and initAccount() have started; safe to call once. */
export async function initSync(): Promise<void> {
  if (started) return;
  started = true;
  try {
    pdoc = parsePdoc((await storeLoad<unknown>("profile")).value);
  } catch {
    // keep defaults
  }
  appliedRevision = libraryRevision();
  subscribeLibrary(onLibraryChange);
  subscribeAddons(onAddonsChange);
  subscribeAccount(onAccountChange);
  activateOwner(pdoc.owner);
  onAccountChange();
  setInterval(() => {
    if (signedInUser() && state.active) void syncNow();
  }, 10 * 60_000);
}

/** For the Trakt module and tests: the user id in an access token. */
export const userIdFromToken = (t: string) => decodeJwt(t)?.sub ?? null;
