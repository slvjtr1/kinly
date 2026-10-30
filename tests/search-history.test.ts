import { beforeEach, describe, expect, it, vi } from "vitest";

const disk: Record<string, unknown> = {};
vi.mock("../src/lib/tauri", () => ({
  storeLoad: vi.fn(async (name: string) => ({ value: disk[name] ?? null, recoveredFrom: null })),
  storeSave: vi.fn(async (name: string, v: unknown) => void (disk[name] = JSON.parse(JSON.stringify(v)))),
}));

import { MAX_SEARCHES, addQuery, clearSearches, forgetSearch, parseSearches, rememberSearch, removeQuery, resetSearchHistoryForTests } from "../src/lib/searchHistory";
import { emitProfileDeleted, resetOwnerForTests, setOwner } from "../src/lib/owner";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const saved = () => (disk.searches as { profiles: Record<string, string[]> } | undefined)?.profiles ?? {};

describe("search history: list rules", () => {
  it("puts the newest first and moves a repeat up instead of duplicating it", () => {
    let l: string[] = [];
    l = addQuery(l, "dune");
    l = addQuery(l, "dark");
    l = addQuery(l, "  DUNE  ");
    expect(l).toEqual(["DUNE", "dark"]);
  });
  it("ignores queries shorter than two characters and normalises spaces", () => {
    expect(addQuery([], " a ")).toEqual([]);
    expect(addQuery([], "the   office")).toEqual(["the office"]);
  });
  it("keeps at most MAX_SEARCHES", () => {
    let l: string[] = [];
    for (let i = 0; i < MAX_SEARCHES + 5; i++) l = addQuery(l, `query ${i}`);
    expect(l).toHaveLength(MAX_SEARCHES);
    expect(l[0]).toBe(`query ${MAX_SEARCHES + 4}`);
  });
  it("removes a single entry", () => {
    expect(removeQuery(["a1", "b2"], "a1")).toEqual(["b2"]);
  });
  it("parses only valid owners and strings, dropping duplicates", () => {
    const doc = parseSearches({ v: 1, profiles: { [A]: ["x1", 5, "X1", "y2"], nope: ["z9"], guest: "bad" } });
    expect(doc.profiles).toEqual({ [A]: ["x1", "y2"] });
    expect(parseSearches(null).profiles).toEqual({});
  });
});

describe("search history: storage", () => {
  beforeEach(() => {
    for (const k of Object.keys(disk)) delete disk[k];
    resetSearchHistoryForTests();
    resetOwnerForTests();
  });

  it("saves per profile, survives a reload, and clears", async () => {
    setOwner(A);
    await rememberSearch("breaking bad");
    await rememberSearch("dune");
    setOwner(B);
    await rememberSearch("severance");
    expect(saved()).toEqual({ [A]: ["dune", "breaking bad"], [B]: ["severance"] });

    // A restart reads the file again.
    resetSearchHistoryForTests();
    setOwner(A);
    await forgetSearch("dune");
    expect(saved()[A]).toEqual(["breaking bad"]);
    await clearSearches();
    expect(saved()[A]).toBeUndefined();
    expect(saved()[B]).toEqual(["severance"]);
  });

  it("forgets a deleted profile's searches", async () => {
    setOwner(A);
    await rememberSearch("dune");
    emitProfileDeleted(A);
    await vi.waitFor(() => expect(saved()[A]).toBeUndefined());
  });
});
