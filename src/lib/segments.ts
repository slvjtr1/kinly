// IntroDB skip segments: which one is active at a given time, and how to ask for them.

export type SegmentKind = "intro" | "recap" | "credits" | "preview";
export type Segment = { kind: SegmentKind; startSec: number; endSec: number | null };

/** The query for a play request: TMDB id when the meta id carries one, else the IMDb id. */
export function segmentQuery(req: { metaId: string; type: string; season?: number; episode?: number; isLocal?: boolean }) {
  if (req.isLocal) return null;
  const tmdb = req.metaId.match(/^tmdb:(\d+)/);
  const imdb = req.metaId.match(/^(tt\d+)/);
  if (!tmdb && !imdb) return null;
  const ep = req.type === "series" && req.season != null && req.episode != null ? { season: req.season, episode: req.episode } : {};
  return { ...(tmdb ? { tmdbId: Number(tmdb[1]) } : { imdbId: imdb![1] }), ...ep };
}

/** Drop malformed segments; credits without an end run to the end of the file. */
export function normalizeSegments(list: unknown, durationSec: number): Segment[] {
  if (!Array.isArray(list)) return [];
  const kinds: SegmentKind[] = ["intro", "recap", "credits", "preview"];
  return list
    .filter((s): s is Segment => !!s && kinds.includes(s.kind) && Number.isFinite(s.startSec) && s.startSec >= 0)
    .map((s) => {
      const end = s.endSec == null || !Number.isFinite(s.endSec) ? (durationSec > 0 ? durationSec : null) : s.endSec;
      return { kind: s.kind, startSec: s.startSec, endSec: end };
    })
    .filter((s) => s.endSec == null || s.endSec - s.startSec >= 1)
    .sort((a, b) => a.startSec - b.startSec);
}

/** The segment containing `t`. The last half second is excluded so a skip that lands on the end does not re-trigger. */
export function activeSegment(segments: Segment[], t: number): Segment | null {
  return segments.find((s) => t >= s.startSec && (s.endSec == null || t < s.endSec - 0.5)) ?? null;
}

export function skipLabel(kind: SegmentKind, hasNext: boolean): string {
  switch (kind) {
    case "intro": return "Skip intro";
    case "recap": return "Skip recap";
    case "preview": return "Skip preview";
    case "credits": return hasNext ? "Next episode" : "Skip credits";
  }
}
