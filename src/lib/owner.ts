// Whose data is active: "guest" or a profile id. sync.ts sets it whenever it swaps the library;
// the per-profile modules (Trakt, TMDB, addons) follow it. It is null until the "profile" store
// has been read at startup, so nothing is loaded into (or migrated to) the wrong owner.

export const GUEST = "guest";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a valid owner key: "guest" or a profile UUID. */
export const ownerKeyOk = (k: unknown): k is string => typeof k === "string" && (k === GUEST || UUID.test(k));

let owner: string | null = null;
const subs = new Set<(owner: string) => void>();
const deleted = new Set<(profileId: string) => void>();

export const getOwner = () => owner;

export function setOwner(next: string): void {
  if (!ownerKeyOk(next) || next === owner) return;
  owner = next;
  subs.forEach((f) => f(next));
}

/** Calls `cb` on every owner change (not for the current one). */
export function onOwnerChange(cb: (owner: string) => void): () => void {
  subs.add(cb);
  return () => void subs.delete(cb);
}

/** A profile was deleted: modules drop its local data (connections). */
export function emitProfileDeleted(profileId: string): void {
  deleted.forEach((f) => f(profileId));
}
export function onProfileDeleted(cb: (profileId: string) => void): () => void {
  deleted.add(cb);
  return () => void deleted.delete(cb);
}

/** Tests only. */
export function resetOwnerForTests(): void {
  owner = null;
}
