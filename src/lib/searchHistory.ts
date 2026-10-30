// Recent searches, per profile (and guest), on this device only: the "searches" store,
// {v: 1, profiles: {[owner]: string[]}} with the newest query first. Separate from watch history
// and downloads; never synced.

import { useSyncExternalStore } from "react";
import { getOwner, onOwnerChange, onProfileDeleted, ownerKeyOk } from "./owner";
import { storeLoad, storeSave } from "./tauri";

export const MAX_SEARCHES = 20;
const MAX_QUERY = 120;

type Doc = { v: 1; profiles: Record<string, string[]> };

const clean = (q: string) => q.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);

/** Adds `query` to the front; an existing entry differing only in case or spacing moves up. */
export function addQuery(list: string[], query: string, max = MAX_SEARCHES): string[] {
  const q = clean(query);
  if (q.length < 2) return list;
  const key = q.toLocaleLowerCase();
  return [q, ...list.filter((x) => x.toLocaleLowerCase() !== key)].slice(0, max);
}

export function removeQuery(list: string[], query: string): string[] {
  return list.filter((x) => x !== query);
}

/** Valid owners and strings only; duplicates and overflow dropped. */
export function parseSearches(x: unknown): Doc {
  const out: Doc = { v: 1, profiles: {} };
  const profiles = x && typeof x === "object" ? (x as { profiles?: unknown }).profiles : null;
  if (!profiles || typeof profiles !== "object") return out;
  for (const [owner, list] of Object.entries(profiles as Record<string, unknown>)) {
    if (!ownerKeyOk(owner) || !Array.isArray(list)) continue;
    const qs = list.filter((q): q is string => typeof q === "string").reverse().reduce<string[]>((acc, q) => addQuery(acc, q), []);
    if (qs.length) out.profiles[owner] = qs;
  }
  return out;
}

let doc: Doc = { v: 1, profiles: {} };
let loaded: Promise<void> | null = null;
let current: string[] = [];
const subs = new Set<() => void>();

const owner = () => getOwner() ?? "guest";
function refresh() {
  current = doc.profiles[owner()] ?? [];
  subs.forEach((f) => f());
}

function load(): Promise<void> {
  loaded ??= storeLoad<unknown>("searches")
    .then((r) => void (doc = parseSearches(r.value)))
    .catch(() => {})
    .then(refresh);
  return loaded;
}

async function write(next: string[]) {
  await load();
  const k = owner();
  const profiles = { ...doc.profiles };
  if (next.length) profiles[k] = next;
  else delete profiles[k];
  doc = { v: 1, profiles };
  refresh();
  await storeSave("searches", doc).catch(() => {});
}

export const rememberSearch = (query: string) => load().then(() => write(addQuery(current, query)));
export const forgetSearch = (query: string) => load().then(() => write(removeQuery(current, query)));
export const clearSearches = () => write([]);

onOwnerChange(() => void load().then(refresh));
onProfileDeleted((id) => {
  void load().then(() => {
    if (!doc.profiles[id]) return;
    const profiles = { ...doc.profiles };
    delete profiles[id];
    doc = { v: 1, profiles };
    void storeSave("searches", doc).catch(() => {});
  });
});

/** The active profile's recent searches, newest first. */
export function useSearchHistory(): string[] {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      void load();
      return () => subs.delete(f);
    },
    () => current,
  );
}

/** Tests only. */
export function resetSearchHistoryForTests() {
  doc = { v: 1, profiles: {} };
  loaded = null;
  current = [];
}
