// "Add a profile" with its options: copy the primary profile's addons and/or its local Trakt and
// TMDB connections, and an optional PIN. Copying from a primary profile that has a PIN needs that
// PIN first (checked by the server). Kept out of the view so the flow can be unit tested.

import { pinMessage, pinOk, setPin, verifyPin } from "./pins";
import { createProfile, getSync, notePinChanged, primaryProfile, type Profile } from "./sync";
import { copyTmdbConnection } from "./tmdb";
import { copyTraktConnection } from "./trakt";

export type NewProfileOptions = {
  copyAddons: boolean;
  copyConnections: boolean;
  /** The primary profile's PIN, when it has one and something is copied from it. */
  primaryPin?: string;
  /** A PIN for the new profile (already entered twice and matched), or null for none. */
  pin?: string | null;
};

/** Whether creating with these options needs the primary profile's PIN. */
export function needsPrimaryPin(opts: Pick<NewProfileOptions, "copyAddons" | "copyConnections">): boolean {
  const primary = primaryProfile();
  return !!primary && !!getSync().pins[primary.id] && (opts.copyAddons || opts.copyConnections);
}

/**
 * Creates the profile. Throws (creating nothing) when the primary's PIN is wrong or locked. Returns
 * the profile and a warning when a later, optional step (copying connections, setting the PIN) failed.
 */
export async function createProfileWithOptions(name: string, avatar: string, opts: NewProfileOptions): Promise<{ profile: Profile; warning?: string }> {
  if (opts.pin != null && !pinOk(opts.pin)) throw new Error("A PIN is 4 to 8 digits.");
  const primary = primaryProfile();
  const from = primary && (opts.copyAddons || opts.copyConnections) ? primary : null;
  if (from && needsPrimaryPin(opts)) {
    const v = await verifyPin(from.id, opts.primaryPin ?? "");
    if (v !== "ok") throw new Error(`${from.name}: ${pinMessage(from.id, v)}`);
  }
  const profile = await createProfile(name, avatar, { copyAddonsFrom: from && opts.copyAddons ? from.id : null });
  const problems: string[] = [];
  if (from && opts.copyConnections) {
    try {
      await Promise.all([copyTraktConnection(from.id, profile.id), copyTmdbConnection(from.id, profile.id)]);
    } catch {
      problems.push("its Trakt and TMDB connections couldn't be copied");
    }
  }
  if (opts.pin) {
    const v = await setPin(profile.id, opts.pin).catch(() => "error" as const);
    if (v === "ok") notePinChanged(profile.id, true);
    else problems.push("its PIN couldn't be set (edit the profile to try again)");
  }
  return { profile, warning: problems.length ? `${profile.name} was created, but ${problems.join(" and ")}.` : undefined };
}
