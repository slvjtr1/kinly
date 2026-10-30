// Kinly's Supabase project, supplied at build time (never committed):
//   VITE_SUPABASE_URL              https://<project-ref>.supabase.co
//   VITE_SUPABASE_PUBLISHABLE_KEY  sb_publishable_…
// Locally they come from `.env.local` (git-ignored, see `.env.example`); release builds get them
// from repository secrets. The publishable key only identifies the project: row-level security
// limits every request to the signed-in user's own rows. Never put a service-role key here.
// A build without them still works, with accounts and the Trakt relay unavailable.

const env = import.meta.env as Record<string, string | undefined>;
const url = (env.VITE_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();

/** True when this build was given a Supabase project. */
export const CLOUD_CONFIGURED = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) && key.length > 0;
// An unroutable placeholder keeps unconfigured builds failing fast with a network error.
export const SUPABASE_URL = CLOUD_CONFIGURED ? url : "https://accounts-unavailable.invalid";
export const SUPABASE_PUBLISHABLE_KEY = CLOUD_CONFIGURED ? key : "";
