import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/tauri", () => ({
  http: vi.fn(),
  httpJson: vi.fn(),
  storeLoad: vi.fn(async () => ({ value: null, recoveredFrom: null })),
  storeSave: vi.fn(async () => {}),
  uiLog: vi.fn(async () => {}),
}));

import type { LibraryDoc, Progress } from "../src/lib/library";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import {
  applySyncedSettings, byteSize, capLibrary, forCloud, mergeLibraries, parseProfiles, pickSyncedSettings, stableJson, validateAddons, validateLibrary,
} from "../src/lib/sync";

const NOW = 1_750_000_000_000;
const prog = (key: string, updatedAt: number, extra: Partial<Progress> = {}): Progress => {
  const [type, ...rest] = key.split(":");
  const videoId = rest.join(":");
  return { key, metaId: videoId.split(":")[0], type, name: "X", videoId, position: 100, duration: 1000, watched: false, updatedAt, ...extra };
};
const lib = (p: Partial<LibraryDoc>): LibraryDoc => ({ watchlist: [], progress: {}, tombstones: {}, ...p });

describe("library merge", () => {
  it("unions both sides and keeps the newest entry per id", () => {
    const a = lib({
      watchlist: [{ id: "tt1", type: "movie", name: "One", addedAt: 10 }],
      progress: { "movie:tt1": prog("movie:tt1", 100, { position: 300 }) },
    });
    const b = lib({
      watchlist: [{ id: "tt2", type: "movie", name: "Two", addedAt: 20 }, { id: "tt1", type: "movie", name: "One", poster: "https://img/1.jpg", addedAt: 5 }],
      progress: { "movie:tt1": prog("movie:tt1", 200, { position: 600 }), "movie:tt2": prog("movie:tt2", 50) },
    });
    const m = mergeLibraries(a, b, NOW);
    expect(m.watchlist.map((w) => w.id)).toEqual(["tt2", "tt1"]);
    expect(m.watchlist[1]).toMatchObject({ addedAt: 10, poster: "https://img/1.jpg" }); // newest wins, gaps filled
    expect(m.progress["movie:tt1"].position).toBe(600);
    expect(Object.keys(m.progress).sort()).toEqual(["movie:tt1", "movie:tt2"]);
  });

  it("is order independent", () => {
    const a = lib({ progress: { "movie:tt1": prog("movie:tt1", 100) }, watchlist: [{ id: "tt3", type: "movie", name: "", addedAt: 3 }] });
    const b = lib({ progress: { "movie:tt1": prog("movie:tt1", 300), "movie:tt9": prog("movie:tt9", 1) } });
    expect(stableJson(mergeLibraries(a, b, NOW))).toBe(stableJson(mergeLibraries(b, a, NOW)));
  });

  it("honours deletions only when newer than the entry", () => {
    const local = lib({ tombstones: { "w:tt1": 50, "p:movie:tt1": 150 } });
    const remote = lib({
      watchlist: [{ id: "tt1", type: "movie", name: "One", addedAt: 40 }, { id: "tt2", type: "movie", name: "Two", addedAt: 60 }],
      progress: { "movie:tt1": prog("movie:tt1", 100), "movie:tt2": prog("movie:tt2", 100) },
    });
    const m = mergeLibraries(local, remote, NOW);
    expect(m.watchlist.map((w) => w.id)).toEqual(["tt2"]);
    expect(Object.keys(m.progress)).toEqual(["movie:tt2"]);
    // Re-adding after the deletion wins.
    const readd = mergeLibraries(m, lib({ watchlist: [{ id: "tt1", type: "movie", name: "One", addedAt: 70 }] }), NOW);
    expect(readd.watchlist.map((w) => w.id)).toEqual(["tt1", "tt2"]);
  });

  it("an imported watched mark keeps the real duration", () => {
    const local = lib({ progress: { "series:tt5:1:1": prog("series:tt5:1:1", 100, { position: 400, duration: 2400, poster: "https://p" }) } });
    const imported = lib({ progress: { "series:tt5:1:1": prog("series:tt5:1:1", 500, { position: 0, duration: 0, watched: true, poster: undefined }) } });
    const m = mergeLibraries(local, imported, NOW).progress["series:tt5:1:1"];
    expect(m).toMatchObject({ watched: true, duration: 2400, position: 2400, poster: "https://p", updatedAt: 500 });
  });

  it("never drops a local-only entry (guest library merged into a profile)", () => {
    const guest = lib({ watchlist: [{ id: "tt7", type: "movie", name: "Seven", addedAt: 1 }], progress: { "local:/a.mkv": prog("local:/a.mkv", 1) } });
    const m = mergeLibraries(lib({}), guest, NOW);
    expect(m.watchlist).toHaveLength(1);
    expect(m.progress["local:/a.mkv"]).toBeDefined();
  });

  it("forgets tombstones older than 180 days", () => {
    const m = mergeLibraries(lib({ tombstones: { "w:old": NOW - 200 * 86_400_000, "w:new": NOW - 1000 } }), lib({}), NOW);
    expect(Object.keys(m.tombstones!)).toEqual(["w:new"]);
  });
});

describe("library validation", () => {
  it("rejects wrong shapes", () => {
    expect(validateLibrary(null)).toBeNull();
    expect(validateLibrary({ watchlist: {}, progress: {} })).toBeNull();
    expect(validateLibrary({ watchlist: [], progress: [] })).toBeNull();
  });
  it("drops invalid entries and unsafe values", () => {
    const v = validateLibrary(
      {
        watchlist: [
          { id: "tt1", type: "movie", name: "One", addedAt: 1, poster: "javascript:alert(1)" },
          { id: "tt1", type: "movie", name: "Dup", addedAt: 2 },
          { id: 5, type: "movie", name: "Bad", addedAt: 1 },
          { id: "tt2", type: "movie", name: "Future", addedAt: NOW * 10 },
        ],
        progress: {
          a: prog("movie:tt1", 1),
          b: { ...prog("movie:tt2", 1), key: "movie:tt-other" }, // key must match type:videoId
          c: { ...prog("movie:tt3", 1), position: -5 },
          d: { ...prog("movie:tt4", 1), watched: "yes" },
          e: { ...prog("series:tt5:1:2", 1), season: 1.5, episode: 2, extra: "dropped" },
        },
        tombstones: { "w:tt9": 5, "x:bad": 5, "p:k": "no" },
      },
      NOW,
    )!;
    expect(v.watchlist.map((w) => w.name)).toEqual(["One", "Future"]);
    expect(v.watchlist[0].poster).toBeUndefined();
    expect(v.watchlist[1].addedAt).toBe(NOW + 86_400_000); // future timestamps clamped
    expect(Object.keys(v.progress).sort()).toEqual(["movie:tt1", "series:tt5:1:2"]);
    expect(v.progress["series:tt5:1:2"].season).toBeUndefined();
    expect((v.progress["series:tt5:1:2"] as unknown as Record<string, unknown>).extra).toBeUndefined();
    expect(v.tombstones).toEqual({ "w:tt9": 5 });
  });
  it("caps the upload size, dropping the oldest finished history first", () => {
    const progress: Record<string, Progress> = {};
    for (let i = 0; i < 4000; i++) progress[`movie:tt${i}`] = prog(`movie:tt${i}`, i, { watched: i < 3000, name: "N".repeat(100) });
    const big = lib({ progress, watchlist: [{ id: "tt1", type: "movie", name: "One", addedAt: 1 }] });
    const capped = capLibrary(big, 300_000);
    expect(byteSize(capped)).toBeLessThanOrEqual(300_000);
    expect(capped.watchlist).toHaveLength(1);
    expect(capped.progress["movie:tt3999"]).toBeDefined(); // unfinished entries kept
    expect(capped.progress["movie:tt0"]).toBeUndefined();
    expect(Object.keys(big.progress)).toHaveLength(4000); // input untouched
  });
});

describe("other server data", () => {
  it("validates profiles", () => {
    const id = "6f1c2b9e-3d4a-4b5c-8d7e-0123456789ab";
    expect(parseProfiles([{ id, name: " Ana ", avatar: "whale" }, { id: "x", name: "B", avatar: "ocean" }, { id, name: "", avatar: "ocean" }, { id, name: "C", avatar: "<img>" }])).toEqual([
      { id, name: "Ana", avatar: "whale" },
    ]);
    expect(parseProfiles({})).toBeNull();
    expect(parseProfiles(Array(10).fill({ id, name: "A", avatar: "ocean" }))).toHaveLength(6);
  });
  it("validates addons", () => {
    const m = { id: "a", name: "A", version: "1", resources: [], types: [], catalogs: [] };
    expect(
      validateAddons([
        { transportUrl: "https://a.example/manifest.json", manifest: m },
        { transportUrl: "https://a.example/manifest.json", manifest: m },
        { transportUrl: "file:///etc/passwd" },
        { transportUrl: "https://b.example/manifest.json", manifest: { id: 1 } },
      ]),
    ).toEqual([{ transportUrl: "https://a.example/manifest.json", manifest: m }, { transportUrl: "https://b.example/manifest.json" }]);
    expect(validateAddons("x")).toBeNull();
  });
  it("applies only the synced settings, re-validated", () => {
    const next = applySyncedSettings(DEFAULT_SETTINGS, {
      appearance: { theme: "dusk", uiScale: 1.5 },
      playback: { seekStep: 30, volume: 5, hwdec: false },
      subtitles: { languages: ["eng", 7] },
      library: { folders: ["/etc"] },
      evil: { x: 1 },
    });
    expect(next.appearance.theme).toBe("dusk");
    expect(next.appearance.uiScale).toBe(DEFAULT_SETTINGS.appearance.uiScale); // device-local
    expect(next.playback.seekStep).toBe(30);
    expect(next.playback.volume).toBe(DEFAULT_SETTINGS.playback.volume);
    expect(next.playback.hwdec).toBe(DEFAULT_SETTINGS.playback.hwdec);
    expect(next.library.folders).toEqual(DEFAULT_SETTINGS.library.folders);
    expect(next.subtitles.languages).toEqual(DEFAULT_SETTINGS.subtitles.languages); // invalid list rejected by sanitizeSettings
    expect(applySyncedSettings(DEFAULT_SETTINGS, { subtitles: { languages: ["eng"] } }).subtitles.languages).toEqual(["eng"]);
    expect(applySyncedSettings(DEFAULT_SETTINGS, applySyncedSettings(DEFAULT_SETTINGS, pickSyncedSettings(next)))).toEqual(next);
  });
});

describe("what leaves the device", () => {
  const local = prog("local:C:\Users\me\Videos\Holiday.mkv", NOW, { source: "C:\Users\me\Videos\Holiday.mkv", background: "http://asset.localhost/C%3A%5Ccache%5Cthumb.jpg" });
  const linuxLocal = prog("local:/home/me/Videos/a.mkv", NOW, { source: "/home/me/Videos/a.mkv", background: "asset://localhost/%2Fhome%2Fme%2F.cache%2Fthumb.jpg" });
  const movie = prog("movie:tt0000001", NOW, { poster: "https://img.example/p.jpg", background: "http://asset.localhost/x.jpg", source: "https://debrid.example/secret-link" });
  const doc = lib({
    watchlist: [{ id: "tt0000001", type: "movie", name: "M", addedAt: NOW, poster: "asset://localhost/p.jpg" }, { id: "/x.mkv", type: "local", name: "L", addedAt: NOW }],
    progress: { [local.key]: local, [linuxLocal.key]: linuxLocal, [movie.key]: movie },
    tombstones: { "p:local:/home/me/old.mkv": NOW, "p:movie:tt9": NOW, "w:tt8": NOW },
  });

  it("drops local files, their thumbnails, sources and device-only image URLs", () => {
    const c = forCloud(doc);
    expect(Object.keys(c.progress)).toEqual(["movie:tt0000001"]);
    expect(c.progress["movie:tt0000001"]).not.toHaveProperty("source");
    expect(c.progress["movie:tt0000001"]).not.toHaveProperty("background");
    expect(c.progress["movie:tt0000001"].poster).toBe("https://img.example/p.jpg");
    expect(c.watchlist).toEqual([{ id: "tt0000001", type: "movie", name: "M", addedAt: NOW }]);
    expect(Object.keys(c.tombstones!).sort()).toEqual(["p:movie:tt9", "w:tt8"]);
    const json = JSON.stringify(c);
    for (const leak of ["Users", "/home/", "asset", "debrid", ".mkv"]) expect(json).not.toContain(leak);
  });

  it("keeps device-only entries in the local library when merging a filtered cloud copy", () => {
    const remote = forCloud(lib({ progress: { [movie.key]: { ...movie, updatedAt: NOW + 5 } } }));
    const merged = mergeLibraries(doc, remote, NOW);
    expect(merged.progress[local.key].source).toBe(local.source);
    expect(merged.progress[linuxLocal.key]).toBeDefined();
  });

  it("does not take another device's local files from an old cloud copy", () => {
    const stale = lib({ progress: { [linuxLocal.key]: linuxLocal } });
    expect(forCloud(stale).progress).toEqual({});
  });

  it("does not change ordinary https images", () => {
    expect(forCloud(lib({ progress: { [movie.key]: { ...movie, background: "https://assets.example/b.jpg" } } })).progress[movie.key].background).toBe("https://assets.example/b.jpg");
  });
});
