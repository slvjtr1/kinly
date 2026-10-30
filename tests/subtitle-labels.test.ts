import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/tauri", () => ({ http: vi.fn(), player: {}, subs: {}, uiLog: vi.fn(async () => {}) }));

import { embeddedCandidates, isSdhLabel, sidecarCandidate } from "../src/lib/subs/controller";

const side = (...tokens: string[]) => sidecarCandidate("/v/Movie.srt", "Movie.srt", tokens);

describe("Hindi vs hearing-impaired subtitles", () => {
  it("reads a lone 'hi' sidecar token as Hindi", () => {
    expect(side("hi")).toMatchObject({ lang: "hin", sdh: false });
    expect(side("hindi")).toMatchObject({ lang: "hin", sdh: false });
  });

  it("reads 'hi' next to another language as hearing-impaired", () => {
    expect(side("en", "hi")).toMatchObject({ lang: "eng", sdh: true });
    expect(side("hi", "en")).toMatchObject({ lang: "eng", sdh: true });
    expect(side("ar", "forced")).toMatchObject({ lang: "ara", sdh: false, forced: true });
  });

  it("still recognises the usual SDH markers", () => {
    expect(side("en", "sdh")).toMatchObject({ lang: "eng", sdh: true });
    expect(side("en", "cc")).toMatchObject({ sdh: true });
    for (const label of ["English SDH", "English (HI)", "Movie.2019.1080p.WEB.HI.srt", "Hearing Impaired", "Closed Captions"]) {
      expect(isSdhLabel(label), label).toBe(true);
    }
  });

  it("does not mistake Hindi titles for SDH", () => {
    for (const label of ["Hindi", "hi", "Movie.2019.hi.srt", "Ghibli", undefined]) expect(isSdhLabel(label), String(label)).toBe(false);
    const [t] = embeddedCandidates([{ id: 3, type: "sub", lang: "hin", title: "Hindi" } as never]);
    expect(t).toMatchObject({ lang: "hin", sdh: false });
  });
});
