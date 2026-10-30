import { describe, expect, it } from "vitest";
import { activeSegment, normalizeSegments, segmentQuery, skipLabel } from "../src/lib/segments";

describe("IntroDB segments", () => {
  it("queries by TMDB id when the meta id has one, else by IMDb id, with the episode for series", () => {
    expect(segmentQuery({ metaId: "tt0903747", type: "series", season: 2, episode: 3 })).toEqual({ imdbId: "tt0903747", season: 2, episode: 3 });
    expect(segmentQuery({ metaId: "tmdb:1396", type: "series", season: 1, episode: 1 })).toEqual({ tmdbId: 1396, season: 1, episode: 1 });
    expect(segmentQuery({ metaId: "tt0133093", type: "movie" })).toEqual({ imdbId: "tt0133093" });
    expect(segmentQuery({ metaId: "local:x", type: "local", isLocal: true })).toBeNull();
    expect(segmentQuery({ metaId: "kitsu:1", type: "series" })).toBeNull();
  });

  it("runs open-ended credits to the end and drops malformed entries", () => {
    const segs = normalizeSegments(
      [
        { kind: "credits", startSec: 2500, endSec: null },
        { kind: "intro", startSec: 60, endSec: 90 },
        { kind: "bogus", startSec: 1, endSec: 2 },
        { kind: "recap", startSec: -5, endSec: 10 },
        { kind: "preview", startSec: 100, endSec: 100.2 },
      ],
      2600,
    );
    expect(segs).toEqual([
      { kind: "intro", startSec: 60, endSec: 90 },
      { kind: "credits", startSec: 2500, endSec: 2600 },
    ]);
    expect(normalizeSegments(undefined, 100)).toEqual([]);
  });

  it("finds the active segment and lets a skip that lands on the end go", () => {
    const segs = normalizeSegments([{ kind: "intro", startSec: 60, endSec: 90 }, { kind: "credits", startSec: 2500, endSec: null }], 2600);
    expect(activeSegment(segs, 59)).toBeNull();
    expect(activeSegment(segs, 75)?.kind).toBe("intro");
    expect(activeSegment(segs, 89.8)).toBeNull();
    expect(activeSegment(segs, 2599)?.kind).toBe("credits");
  });

  it("labels the button", () => {
    expect(skipLabel("intro", true)).toBe("Skip intro");
    expect(skipLabel("recap", false)).toBe("Skip recap");
    expect(skipLabel("credits", true)).toBe("Next episode");
    expect(skipLabel("credits", false)).toBe("Skip credits");
  });
});
