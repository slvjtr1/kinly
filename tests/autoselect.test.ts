import { describe, expect, it } from "vitest";
import { contentMatches, pickSyncAudioTrack, rankCandidates, type SelectContext, type SubCandidate } from "../src/lib/subs/autoselect";
import { parseRelease } from "../src/lib/release";

const ctx = (over: Partial<SelectContext> = {}): SelectContext => ({
  languages: ["ara", "eng"],
  avoidSdh: true,
  video: null,
  expected: null,
  remembered: null,
  audioLang: "eng",
  ...over,
});

const addon = (id: string, lang: string, extra: Partial<SubCandidate> = {}): SubCandidate => ({
  id,
  source: "addon",
  lang,
  label: id,
  forced: false,
  sdh: false,
  url: `https://subs.example/${id}`,
  ...extra,
});

const top = (cands: SubCandidate[], c: SelectContext = ctx()) => rankCandidates(cands, c)[0]?.candidate.id;

describe("Auto Select ranking", () => {
  it("prefers Arabic, then English", () => {
    expect(top([addon("en1", "eng"), addon("ar1", "ara")])).toBe("ar1");
    expect(top([addon("en1", "eng"), addon("fr1", "fre")])).toBe("en1");
  });

  it("returns nothing when no wanted language is available", () => {
    expect(rankCandidates([addon("fr1", "fre"), addon("x", "")], ctx())).toEqual([]);
  });

  it("rejects a wrong-episode Arabic subtitle in favour of a correct English one", () => {
    const c = ctx({ expected: { season: 2, episode: 5 } });
    const wrong = addon("ar-wrong", "ara", { name: "Show.S02E04.1080p.WEB-DL.srt" });
    const right = addon("en-right", "eng", { name: "Show.S02E05.1080p.WEB-DL.srt" });
    expect(top([wrong, right], c)).toBe("en-right");
  });

  it("keeps an Arabic subtitle without episode info (no evidence of mismatch)", () => {
    const c = ctx({ expected: { season: 2, episode: 5 } });
    expect(top([addon("ar", "ara", { name: "Arabic subtitles" }), addon("en", "eng", { name: "Show.S02E05.srt" })], c)).toBe(
      "ar",
    );
  });

  it("picks the Arabic subtitle whose release matches the video", () => {
    const video = parseRelease("Movie.2021.1080p.BluRay.x264-GRP.mkv");
    const c = ctx({ video });
    const web = addon("ar-web", "ara", { name: "Movie.2021.720p.WEBRip.x265-OTHER", addonRank: 0 });
    const bd = addon("ar-bd", "ara", { name: "Movie.2021.1080p.BluRay.x264-GRP", addonRank: 5 });
    expect(top([web, bd], c)).toBe("ar-bd");
  });

  it("rejects a subtitle for a different year of the same title", () => {
    const c = ctx({ video: parseRelease("Dune.2021.2160p.WEB-DL.mkv") });
    expect(top([addon("old", "ara", { name: "Dune.1984.DVDRip" }), addon("en", "eng")], c)).toBe("en");
  });

  it("never picks a forced track over a full one, even in a less preferred language", () => {
    const forcedAr: SubCandidate = { ...addon("ar-forced", "ara"), source: "embedded", forced: true, sid: 3 };
    expect(top([forcedAr, addon("en", "eng")])).toBe("en");
    // ...but uses it when it is the only option.
    expect(top([forcedAr])).toBe("ar-forced");
  });

  it("prefers non-SDH within the same language when asked to", () => {
    expect(top([addon("sdh", "eng", { sdh: true, addonRank: 0 }), addon("plain", "eng", { addonRank: 3 })], ctx({ languages: ["eng"] }))).toBe(
      "plain",
    );
    expect(
      top([addon("sdh", "eng", { sdh: true, addonRank: 0 }), addon("plain", "eng", { addonRank: 3 })], ctx({ languages: ["eng"], avoidSdh: false })),
    ).toBe("sdh");
  });

  it("prefers embedded text over remote in the same language, and text over image subtitles", () => {
    const emb: SubCandidate = { id: "emb", source: "embedded", lang: "ara", label: "e", forced: false, sdh: false, sid: 2, codec: "subrip" };
    expect(top([addon("ar", "ara"), emb])).toBe("emb");
    const pgs: SubCandidate = { ...emb, id: "pgs", codec: "hdmv_pgs_subtitle", sid: 4 };
    expect(top([pgs, addon("ar", "ara")])).toBe("ar");
  });

  it("does not pick one part of a multi-CD subtitle over a complete one", () => {
    expect(top([addon("cd1", "ara", { name: "Movie.1994.CD1.aFLDp.srt", addonRank: 0 }), addon("full", "eng")])).toBe("full");
  });

  it("deduplicates candidates pointing at the same file", () => {
    const r = rankCandidates([addon("a", "ara", { url: "https://x/1" }), addon("b", "ara", { url: "https://x/1" })], ctx());
    expect(r).toHaveLength(1);
  });

  it("moves a remembered manual language choice to the front", () => {
    expect(top([addon("ar", "ara"), addon("en", "eng")], ctx({ remembered: "eng" }))).toBe("en");
  });

  it("is deterministic regardless of input order", () => {
    const cands = [addon("b", "ara"), addon("a", "ara"), addon("c", "eng")];
    const first = top(cands);
    for (let i = 0; i < 5; i++) expect(top([...cands].reverse())).toBe(first);
    expect(first).toBe("a");
  });
});

describe("content language check", () => {
  const arabicText = { language: "ara", script: "arabic", confidence: 0.95 };
  it("accepts matching content", () => {
    expect(contentMatches("ara", arabicText, "ara")).toBe(true);
    expect(contentMatches("eng", { language: null, script: "latin", confidence: 0.99 }, null)).toBe(true);
  });
  it("rejects Persian labelled as Arabic", () => {
    expect(contentMatches("ara", { language: "fas", script: "arabic", confidence: 0.95 }, "per")).toBe(false);
  });
  it("rejects Latin text labelled Arabic and Arabic text labelled English", () => {
    expect(contentMatches("ara", { language: null, script: "latin", confidence: 0.98 }, null)).toBe(false);
    expect(contentMatches("eng", arabicText, "ara")).toBe(false);
  });
  it("does not judge low-confidence or unknown cases", () => {
    expect(contentMatches("ara", { language: null, script: "latin", confidence: 0.4 }, null)).toBe(true);
    expect(contentMatches(null, arabicText, "ara")).toBe(true);
  });
});

describe("release parsing", () => {
  it("parses episodes in common forms", () => {
    expect(parseRelease("The.Show.S01E02.720p.HDTV.x264-GRP.mkv")).toMatchObject({ title: "The Show", season: 1, episode: 2, resolution: 720 });
    expect(parseRelease("the show 3x07.mp4")).toMatchObject({ season: 3, episode: 7 });
    expect(parseRelease("Movie Name (2019) [1080p].mkv")).toMatchObject({ title: "Movie Name", year: 2019, resolution: 1080 });
  });
});

describe("pickSyncAudioTrack", () => {
  const a = (ff: number, lang?: string, extra: Record<string, unknown> = {}) => ({ type: "audio", "ff-index": ff, lang, ...extra });
  it("prefers the track in the subtitle's language", () => {
    const tracks = [a(1, "fre", { default: true, selected: true }), a(2, "eng"), { type: "sub", "ff-index": 3, lang: "eng" }];
    expect(pickSyncAudioTrack(tracks, "eng", 1)).toBe(2);
    expect(pickSyncAudioTrack(tracks, "en", 1)).toBe(2);
  });
  it("falls back to the default track, then the playing one", () => {
    expect(pickSyncAudioTrack([a(1, "fre"), a(2, "ger", { default: true })], "ara", 1)).toBe(2);
    expect(pickSyncAudioTrack([a(1, "fre"), a(2, "ger")], "ara", 2)).toBe(2);
    expect(pickSyncAudioTrack([], "ara", 4)).toBe(4);
  });
  it("skips commentary tracks", () => {
    const tracks = [a(1, "eng", { title: "Director's Commentary", default: true }), a(2, "eng", { title: "Main" })];
    expect(pickSyncAudioTrack(tracks, "eng", 1)).toBe(2);
  });
});
