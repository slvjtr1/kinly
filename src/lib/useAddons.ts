// The active owner's installed addons. Guest mode keeps its list in the local "addons" store; each
// profile has its own list, which sync.ts loads (from its offline copy and profile_data.addons) and
// hands over with setAddonsOwner/replaceAddons, and which it saves and uploads when it changes.

import { useSyncExternalStore } from "react";
import { fetchManifest, loadAddons, normalizeTransportUrl, saveAddons, type Addon } from "./addons";
import { GUEST } from "./owner";

type State = { status: "loading" | "ready" | "error"; addons: Addon[]; error?: string; owner: string | null };

let state: State = { status: "loading", addons: [], owner: null };
let gen = 0;
const subs = new Set<() => void>();
const set = (s: State) => {
  state = s;
  subs.forEach((f) => f());
};

const OFFLINE = "Could not reach the default addons. Check your connection.";

async function loadGuest(g: number) {
  try {
    const addons = await loadAddons();
    if (g !== gen) return;
    set({ status: addons.length ? "ready" : "error", addons, error: addons.length ? undefined : OFFLINE, owner: GUEST });
  } catch (e) {
    if (g === gen) set({ status: "error", addons: [], error: e instanceof Error ? e.message : String(e), owner: GUEST });
  }
}

/** Boot hook (main.tsx). The owner arrives from sync.ts; for a guest this retries loading the list. */
export async function initAddons() {
  if (state.owner === GUEST && state.status !== "ready") await loadGuest(++gen);
}

/**
 * Switches to another owner's list. Guests load the local store; a profile shows `list` (its
 * offline copy) right away, or "loading" until sync.ts has fetched or seeded it.
 */
export async function setAddonsOwner(owner: string, list: Addon[] | null): Promise<void> {
  const g = ++gen;
  if (owner === GUEST) {
    set({ status: "loading", addons: [], owner });
    await loadGuest(g);
  } else set(list ? { status: "ready", addons: list, owner } : { status: "loading", addons: [], owner });
}

/** sync.ts couldn't get a profile's list (offline, nothing cached). */
export function addonsUnavailable(owner: string, error = OFFLINE) {
  if (state.owner === owner && state.status === "loading") set({ ...state, status: "error", error });
}

async function persist(owner: string | null, addons: Addon[]) {
  if (owner === GUEST) await saveAddons(addons);
  // Profiles: sync.ts saves the offline copy and uploads it (it subscribes to changes).
}

export async function installAddon(input: string): Promise<Addon> {
  const transportUrl = normalizeTransportUrl(input);
  if (state.addons.some((a) => a.transportUrl === transportUrl)) throw new Error("This addon is already installed");
  const owner = state.owner;
  const addon = { transportUrl, manifest: await fetchManifest(transportUrl) };
  if (state.owner !== owner) throw new Error("The profile changed while installing. Try again.");
  if (state.addons.some((a) => a.transportUrl === transportUrl)) return addon;
  const addons = [...state.addons, addon];
  await persist(owner, addons);
  set({ status: "ready", addons, owner });
  return addon;
}

export async function removeAddon(transportUrl: string) {
  const owner = state.owner;
  const addons = state.addons.filter((a) => a.transportUrl !== transportUrl);
  await persist(owner, addons);
  if (state.owner === owner) set({ ...state, addons });
}

export async function moveAddon(transportUrl: string, delta: -1 | 1) {
  const owner = state.owner;
  const addons = [...state.addons];
  const i = addons.findIndex((a) => a.transportUrl === transportUrl);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= addons.length) return;
  [addons[i], addons[j]] = [addons[j], addons[i]];
  await persist(owner, addons);
  if (state.owner === owner) set({ ...state, addons });
}

export const getAddonsState = () => state;
export function subscribeAddons(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** Replaces `owner`'s installed list (cloud sync). Ignored when another owner is active by now. */
export async function replaceAddons(addons: Addon[], owner: string | null = state.owner): Promise<boolean> {
  if (owner !== state.owner) return false;
  await persist(owner, addons);
  if (owner !== state.owner) return false;
  set({ status: "ready", addons, owner });
  return true;
}

export function useAddons(): State {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}
