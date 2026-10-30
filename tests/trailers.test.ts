import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ video: "https://v.example/1", audio: null })) }));

import { embedUrl, hasTrailer, resolveTrailer, trailersOf } from "../src/lib/trailers";

describe("trailers from addon metadata", () => {
  it("reads Cinemeta's trailers and trailerStreams, de-duplicated", () => {
    const meta = {
      trailers: [{ source: "cdx31ak4KbQ", type: "Trailer" }, { source: "JE9z-gy4De4", type: "Teaser" }],
      trailerStreams: [{ title: "Inception", ytId: "cdx31ak4KbQ" }, { title: "Inception", ytId: "Jvurpf91omw" }],
    };
    const t = trailersOf(meta);
    expect(t.map((x) => x.ytId)).toEqual(["cdx31ak4KbQ", "Jvurpf91omw", "JE9z-gy4De4"]); // the teaser goes last
    expect(t[0]).toMatchObject({ title: "Inception", kind: "Trailer" });
    expect(hasTrailer(meta)).toBe(true);
  });

  it("ignores missing, malformed and unsafe entries", () => {
    expect(trailersOf(null)).toEqual([]);
    expect(trailersOf({})).toEqual([]);
    expect(hasTrailer({ trailers: "x", trailerStreams: {} })).toBe(false);
    expect(trailersOf({ trailers: [null, 5, { source: "../../etc" }, { source: "abc" }, { source: "cdx31ak4KbQ&x=1" }] })).toEqual([]);
  });

  it("builds a privacy-enhanced embed URL and rejects bad ids", async () => {
    expect(embedUrl("cdx31ak4KbQ")).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/cdx31ak4KbQ\?/);
    expect(() => embedUrl("bad id")).toThrow();
    await expect(resolveTrailer("nope")).rejects.toThrow();
    await expect(resolveTrailer("cdx31ak4KbQ")).resolves.toEqual({ video: "https://v.example/1", audio: null });
  });
});
