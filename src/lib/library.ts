// Watchlist, playback progress and history, plus per-title subtitle language memory.
// Kept in memory, persisted with a short debounce.

import { onShutdown } from "./shutdown";
import { storeLoad, storeSave } from "./tauri";

export type LibItem = { id: string; type: string; name: string; poster?: string; addedAt: number };

export type Progress = {
  key: string;
  metaId: string;
  type: string; // movie | series | local
  name: string;
  poster?: string;
  background?: string;
  videoId: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  /** Local file path or stream URL the user last played. */
  source?: string;
  position: number;
  duration: number;
  watched: boolean;
  updatedAt: number;
};

/**
 * `tombstones` remember deletions ("w:<id>" for watchlist, "p:<key>" for progress) so cloud sync
 * can merge without resurrecting them.
 */
export type LibraryDoc = { watchlist: LibItem[]; progress: Record<string, Progress>; tombstones?: Record<string, number> };
type SubPrefs = Record<string, { lang: string; at: number }>;

let doc: LibraryDoc = { watchlist: [], progress: {} };
let subPrefs: SubPrefs = {};
let loaded = false;
const listeners = new Set<() => void>();
let saveTimer: number | undefined;
let revision = 0;

const tomb = (keys: string[]) => {
  const t = { ...doc.tombstones };
  const now = Date.now();
  for (const k of keys) t[k] = now;
  return t;
};

export async function loadLibrary(): Promise<string | null> {
  const [lib, prefs] = await Promise.all([storeLoad<LibraryDoc>("library"), storeLoad<SubPrefs>("subprefs")]);
  if (lib.value && Array.isArray(lib.value.watchlist) && typeof lib.value.progress === "object") doc = withoutRemovedFields(lib.value);
  if (prefs.value && typeof prefs.value === "object") subPrefs = prefs.value;
  loaded = true;
  emit();
  return lib.recoveredFrom;
}

/**
 * Drops fields of removed features from a stored library. Collections (removed in 1.0.0) may still
 * be in old files and cloud copies; they are ignored and not written back.
 */
export function withoutRemovedFields(d: LibraryDoc): LibraryDoc {
  if (!("collections" in d)) return d;
  const { collections: _collections, ...rest } = d as LibraryDoc & { collections?: unknown };
  return rest;
}

function emit() {
  for (const l of listeners) l();
}

function persist() {
  revision++;
  emit();
  if (!loaded) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void storeSave("library", doc);
  }, 800);
}

export function subscribeLibrary(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const progressKey = (type: string, videoId: string) => `${type}:${videoId}`;

export function getLibrary() {
  return doc;
}

/** Counts local changes (user edits and replaceLibrary); used by cloud sync to detect edits. */
export const libraryRevision = () => revision;

/** Replaces the whole library (profile switch, cloud merge). Persists like any other change. */
export function replaceLibrary(next: LibraryDoc) {
  doc = withoutRemovedFields(next);
  persist();
}

/** Writes pending changes now instead of after the debounce. */
export async function flushLibrary() {
  if (!loaded || saveTimer === undefined) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  await storeSave("library", doc);
}
onShutdown(flushLibrary);

export function inWatchlist(id: string) {
  return doc.watchlist.some((w) => w.id === id);
}

export function toggleWatchlist(item: Omit<LibItem, "addedAt">) {
  doc = inWatchlist(item.id)
    ? { ...doc, watchlist: doc.watchlist.filter((w) => w.id !== item.id), tombstones: tomb([`w:${item.id}`]) }
    : { ...doc, watchlist: [{ ...item, addedAt: Date.now() }, ...doc.watchlist] };
  persist();
}

export function saveProgress(p: Omit<Progress, "watched" | "updatedAt">, watchedThreshold: number) {
  if (!(p.duration > 0)) return;
  const watched = p.position / p.duration >= watchedThreshold;
  doc = { ...doc, progress: { ...doc.progress, [p.key]: { ...p, watched, updatedAt: Date.now() } } };
  persist();
}

export function getProgress(key: string): Progress | undefined {
  return doc.progress[key];
}

export function markWatched(key: string, watched: boolean) {
  const p = doc.progress[key];
  if (!p) return;
  doc = { ...doc, progress: { ...doc.progress, [key]: { ...p, watched, position: watched ? p.duration : 0, updatedAt: Date.now() } } };
  persist();
}

export function removeProgress(key: string) {
  const { [key]: _removed, ...rest } = doc.progress;
  doc = { ...doc, progress: rest, tombstones: tomb([`p:${key}`]) };
  persist();
}

export function clearHistory() {
  doc = { ...doc, progress: {}, tombstones: tomb(Object.keys(doc.progress).map((k) => `p:${k}`)) };
  persist();
}

/** Partially watched items, newest first; one entry per series (its latest episode). */
export function continueWatching(limit = 20): Progress[] {
  const latest = new Map<string, Progress>();
  for (const p of Object.values(doc.progress)) {
    const prev = latest.get(p.metaId);
    if (!prev || p.updatedAt > prev.updatedAt) latest.set(p.metaId, p);
  }
  return [...latest.values()]
    .filter((p) => !p.watched && p.position > 30)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export function history(limit = 200): Progress[] {
  return Object.values(doc.progress)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export function rememberedSubLang(metaId: string): string | null {
  return subPrefs[metaId]?.lang ?? null;
}

export function rememberSubLang(metaId: string, lang: string) {
  subPrefs = { ...subPrefs, [metaId]: { lang, at: Date.now() } };
  void storeSave("subprefs", subPrefs);
}
