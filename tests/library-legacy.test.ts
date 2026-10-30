import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/tauri", () => ({
  http: vi.fn(),
  httpJson: vi.fn(),
  storeLoad: vi.fn(async (name: string) =>
    name === "library"
      ? {
          value: {
            watchlist: [{ id: "tt1", type: "movie", name: "One", addedAt: 1 }],
            progress: {},
            collections: [{ id: "c1", name: "Marvel", items: [{ id: "tt1", type: "movie", name: "One" }], updatedAt: 5 }],
            tombstones: { "c:old": 3 },
          },
          recoveredFrom: null,
        }
      : { value: null, recoveredFrom: null },
  ),
  storeSave: vi.fn(async () => {}),
  uiLog: vi.fn(async () => {}),
}));

import { getLibrary, loadLibrary, replaceLibrary, withoutRemovedFields, type LibraryDoc } from "../src/lib/library";
import { capLibrary, mergeLibraries, parseProfiles, validateLibrary } from "../src/lib/sync";
import { AVATAR_ART, LEGACY_AVATARS, avatarArt } from "../src/views/avatars";

const NOW = 1_750_000_000_000;
const legacy = { id: "c1", name: "Marvel", items: [{ id: "tt1", type: "movie", name: "One" }], updatedAt: NOW - 10 };

describe("removed collections feature", () => {
  it("ignores old collections when the library file is loaded", async () => {
    await loadLibrary();
    const doc = getLibrary();
    expect(doc.watchlist.map((w) => w.id)).toEqual(["tt1"]);
    expect("collections" in doc).toBe(false);
  });

  it("strips collections from replaced libraries", () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout }); // the debounced save after loading
    replaceLibrary({ watchlist: [], progress: {}, collections: [legacy] } as LibraryDoc);
    expect("collections" in getLibrary()).toBe(false);
    const clean: LibraryDoc = { watchlist: [], progress: {} };
    expect(withoutRemovedFields(clean)).toBe(clean);
  });

  it("drops collections and their tombstones from server copies", () => {
    const doc = validateLibrary({ watchlist: [], progress: {}, collections: [legacy, "junk", null], tombstones: { "c:x": NOW - 5, "w:tt9": NOW - 5 } }, NOW)!;
    expect(doc).not.toBeNull();
    expect("collections" in doc).toBe(false);
    expect(doc.tombstones).toEqual({ "w:tt9": NOW - 5 });
    // A malformed collections field never breaks validation.
    expect(validateLibrary({ watchlist: [], progress: {}, collections: "nope" }, NOW)).not.toBeNull();
  });

  it("merges and caps without collections", () => {
    const a = { watchlist: [], progress: {}, collections: [legacy] } as LibraryDoc;
    const m = mergeLibraries(a, { watchlist: [], progress: {}, tombstones: {} }, NOW);
    expect("collections" in m).toBe(false);
    expect("collections" in capLibrary(m, 2000)).toBe(false);
  });
});

describe("profile avatars", () => {
  it("parses profiles with image-link avatars", () => {
    const id = "6f1c2b9e-3d4a-4b5c-8d7e-0123456789ab";
    expect(parseProfiles([{ id, name: "Ana", avatar: "https://example.com/a.png" }])?.[0].avatar).toBe("https://example.com/a.png");
    expect(parseProfiles([{ id, name: "Ana", avatar: "http://example.com/a.png" }])).toEqual([]);
  });

  it("has a dozen distinct built-ins and maps every old emoji key", () => {
    const keys = AVATAR_ART.map((a) => a.key);
    expect(keys.length).toBeGreaterThanOrEqual(12);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9-]{1,24}$/);
    for (const [old, next] of Object.entries(LEGACY_AVATARS)) {
      expect(keys).toContain(next);
      expect(avatarArt(old).key).toBe(next);
    }
    expect(avatarArt("unknown-key").key).toBe(keys[0]);
  });
});
