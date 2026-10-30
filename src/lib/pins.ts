// Profile PINs: a household lock checked by the server (supabase/migrations/20261029100000_*).
// The PIN hash never reaches the client; these calls only send a PIN and get back a verdict.
// PINs are never logged or stored.

import { authedRequest } from "./account";

export type PinResult = "ok" | "wrong" | "locked";
export type SetPinResult = PinResult | "invalid";

export const PIN_MIN = 4;
export const PIN_MAX = 8;
/** 4 to 8 digits, as the server requires. */
export const pinOk = (pin: string): boolean => /^[0-9]{4,8}$/.test(pin);
/** Keeps only digits, at most PIN_MAX of them (for input fields). */
export const pinInput = (raw: string): string => raw.replace(/\D+/g, "").slice(0, PIN_MAX);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_MS = 5 * 60_000;

export class PinError extends Error {}

async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  let r;
  try {
    r = await authedRequest(`/rest/v1/rpc/${name}`, { method: "POST", body });
  } catch {
    throw new PinError("Couldn't check the PIN. Check your connection and try again.");
  }
  if (r.status < 200 || r.status >= 300) throw new PinError(r.status === 401 || r.status === 403 ? "Not authorised. Sign in again." : "Couldn't check the PIN right now. Try again.");
  try {
    return JSON.parse(r.body) as unknown;
  } catch {
    throw new PinError("Unexpected response from the cloud.");
  }
}

/** Parses profile_pin_status(): which profiles have a PIN. */
export function parsePinStatus(x: unknown): Record<string, boolean> | null {
  if (!Array.isArray(x)) return null;
  const out: Record<string, boolean> = {};
  for (const r of x) {
    if (!r || typeof r !== "object") continue;
    const { profile_id, has_pin } = r as Record<string, unknown>;
    if (typeof profile_id === "string" && UUID.test(profile_id) && typeof has_pin === "boolean") out[profile_id] = has_pin;
  }
  return out;
}

const VERDICTS = new Set(["ok", "wrong", "locked", "invalid"]);
function verdict(x: unknown): SetPinResult {
  const v = typeof x === "string" ? x : Array.isArray(x) && typeof x[0] === "string" ? x[0] : null;
  if (!v || !VERDICTS.has(v)) throw new PinError("Unexpected response from the cloud.");
  return v as SetPinResult;
}

// Local bookkeeping for the "try again in N min" estimate. The server only answers "locked", so
// the time left is estimated from the wrong guesses made in this session (a lock lasts 5 minutes
// after the 5th wrong guess in a row, doubling after that). Nothing here is persisted.
const wrongs = new Map<string, { count: number; at: number }>();
const lockedAt = new Map<string, number>();

function note(profileId: string, v: SetPinResult, now: number) {
  if (v === "ok") {
    wrongs.delete(profileId);
    lockedAt.delete(profileId);
  } else if (v === "wrong") {
    const w = wrongs.get(profileId);
    lockedAt.delete(profileId);
    wrongs.set(profileId, { count: (w?.count ?? 0) + 1, at: now });
  } else if (v === "locked" && !lockedAt.has(profileId)) {
    lockedAt.set(profileId, wrongs.get(profileId)?.at ?? now);
  }
}

/** Minutes until a locked profile can be tried again (an estimate, at least 1). */
export function lockMinutesLeft(profileId: string, now = Date.now()): number {
  const since = lockedAt.get(profileId) ?? now;
  const count = wrongs.get(profileId)?.count ?? 5;
  const length = LOCK_MS * 2 ** Math.max(0, Math.min(count, 13) - 5);
  return Math.max(1, Math.ceil((since + Math.min(length, 86_400_000) - now) / 60_000));
}

/** A user-facing message for a verdict other than "ok". */
export function pinMessage(profileId: string, v: SetPinResult, now = Date.now()): string {
  if (v === "locked") {
    const n = lockMinutesLeft(profileId, now);
    return `Too many wrong PINs. This profile is locked; try again in ${n} min.`;
  }
  if (v === "invalid") return `A PIN is ${PIN_MIN} to ${PIN_MAX} digits.`;
  if (v === "wrong") return "Wrong PIN. After 5 wrong tries the profile locks for 5 minutes.";
  return "";
}

/** Which of the account's profiles have a PIN. */
export async function fetchPinStatus(): Promise<Record<string, boolean>> {
  const s = parsePinStatus(await rpc("profile_pin_status", {}));
  if (!s) throw new PinError("Unexpected response from the cloud.");
  return s;
}

/** Checks a profile's PIN. Profiles without a PIN answer "ok". */
export async function verifyPin(profileId: string, pin: string, now = Date.now()): Promise<PinResult> {
  if (!UUID.test(profileId)) throw new PinError("Unknown profile.");
  if (!pinOk(pin)) return "wrong"; // never sent, so the server didn't count it
  const v = verdict(await rpc("verify_profile_pin", { p_profile: profileId, p_pin: pin }));
  if (v === "invalid") throw new PinError("Unexpected response from the cloud.");
  note(profileId, v, now);
  return v;
}

/**
 * Sets (pin), changes or removes (pin = null) a profile's PIN. Changing or removing an existing
 * PIN needs `current`, or a password sign-in in the last 5 minutes (account.reauthenticate).
 */
export async function setPin(profileId: string, pin: string | null, current: string | null = null, now = Date.now()): Promise<SetPinResult> {
  if (!UUID.test(profileId)) throw new PinError("Unknown profile.");
  if (pin !== null && !pinOk(pin)) return "invalid";
  const v = verdict(await rpc("set_profile_pin", { p_profile: profileId, p_pin: pin, p_current: current && current.length ? current : null }));
  if (v !== "invalid") note(profileId, v, now);
  return v;
}

/** Tests only. */
export function resetPinBookkeeping(): void {
  wrongs.clear();
  lockedAt.clear();
}
