import { describe, expect, it } from "vitest";
import { applyDownloadEvent, downloadTitle, matchesDownload, sortDownloads } from "../src/lib/downloads";
import type { DownloadRecord } from "../src/lib/tauri";

const rec = (id: number, over: Partial<DownloadRecord> = {}): DownloadRecord => ({
  id, name: `file${id}.mkv`, path: `/v/file${id}.mkv`, received: id * 10, total: id * 10, state: "done", error: null, created: id, finished: id, info: {}, ...over,
});

describe("downloads list", () => {
  it("titles episodes, movies and unknown files", () => {
    expect(downloadTitle(rec(1, { info: { title: "Dark", season: 1, episode: 2 } }))).toBe("Dark · S01E02");
    expect(downloadTitle(rec(1, { info: { title: "Dune" } }))).toBe("Dune");
    expect(downloadTitle(rec(1))).toBe("file1.mkv");
  });

  it("sorts by date, title, size and status", () => {
    const list = [rec(1, { info: { title: "b" } }), rec(3, { info: { title: "a" }, state: "failed" }), rec(2, { info: { title: "c" } })];
    expect(sortDownloads(list, "date").map((r) => r.id)).toEqual([3, 2, 1]);
    expect(sortDownloads(list, "title").map((r) => r.id)).toEqual([3, 1, 2]);
    expect(sortDownloads(list, "size").map((r) => r.id)).toEqual([3, 2, 1]);
    expect(sortDownloads(list, "status").map((r) => r.id)).toEqual([3, 2, 1]);
    expect(list.map((r) => r.id)).toEqual([1, 3, 2]); // input untouched
  });

  it("filters on title and file name", () => {
    const r = rec(4, { name: "Movie.2160p.mkv", info: { title: "Arrival" } });
    expect(matchesDownload(r, "arri")).toBe(true);
    expect(matchesDownload(r, "2160P")).toBe(true);
    expect(matchesDownload(r, "dune")).toBe(false);
    expect(matchesDownload(r, " ")).toBe(true);
  });

  it("applies progress events: replace, add, drop cancelled", () => {
    let l = [rec(1), rec(2)];
    l = applyDownloadEvent(l, rec(2, { received: 99 }));
    expect(l.find((r) => r.id === 2)?.received).toBe(99);
    l = applyDownloadEvent(l, rec(3, { state: "running" }));
    expect(l.map((r) => r.id)).toContain(3);
    l = applyDownloadEvent(l, rec(3, { state: "cancelled" }));
    expect(l.map((r) => r.id)).toEqual([2, 1]);
  });
});
