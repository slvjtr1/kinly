// Trailers from addon metadata. Cinemeta sends `trailers: [{ source: <YouTube id>, type }]` and
// `trailerStreams: [{ ytId, title }]` on both catalog previews and full metas.
//
// Playback: Rust resolves the YouTube id with yt-dlp (player/trailer.rs) and the stream plays in
// Kinly's own player. When that fails (no yt-dlp, an outdated one, a refused stream) the trailer
// plays in an in-app youtube-nocookie.com embed instead; it never opens a browser.

import { invoke } from "@tauri-apps/api/core";

export type Trailer = { ytId: string; title?: string; kind?: string };
export type TrailerStream = { video: string; audio: string | null };

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
export const YTDLP_MISSING = "ytdlp-missing";

type Raw = { trailers?: unknown; trailerStreams?: unknown };
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The title's YouTube trailers, de-duplicated; real trailers before teasers and clips. */
export function trailersOf(meta: object | null | undefined): Trailer[] {
  if (!meta) return [];
  const m = meta as Raw;
  const out = new Map<string, Trailer>();
  const add = (id: unknown, title?: unknown, kind?: unknown) => {
    if (typeof id !== "string" || !YT_ID.test(id)) return;
    const prev = out.get(id);
    out.set(id, {
      ytId: id,
      title: (typeof title === "string" && title.slice(0, 200)) || prev?.title,
      kind: (typeof kind === "string" && kind.slice(0, 40)) || prev?.kind,
    });
  };
  if (Array.isArray(m.trailers)) for (const t of m.trailers.slice(0, 20)) if (isObj(t)) add(t.source, undefined, t.type);
  if (Array.isArray(m.trailerStreams)) for (const t of m.trailerStreams.slice(0, 20)) if (isObj(t)) add(t.ytId, t.title);
  const rank = (t: Trailer) => (!t.kind || /trailer/i.test(t.kind) ? 0 : 1);
  return [...out.values()].sort((a, b) => rank(a) - rank(b));
}

export const hasTrailer = (meta: object | null | undefined) => trailersOf(meta).length > 0;

/** Direct stream URLs for the built-in player. Rejects with YTDLP_MISSING when yt-dlp is not installed. */
export function resolveTrailer(ytId: string): Promise<TrailerStream> {
  if (!YT_ID.test(ytId)) return Promise.reject(new Error("invalid trailer id"));
  return invoke<TrailerStream>("trailer_resolve", { ytId });
}

/** The privacy-enhanced embed used as the fallback (allowed by the CSP's frame-src). */
export function embedUrl(ytId: string): string {
  if (!YT_ID.test(ytId)) throw new Error("invalid trailer id");
  return `https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3`;
}
