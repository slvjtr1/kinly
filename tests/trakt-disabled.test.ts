import { describe, expect, it, vi } from "vitest";

const disk: Record<string, unknown> = {};
vi.mock("../src/lib/tauri", () => ({
  http: vi.fn(),
  httpJson: vi.fn(),
  storeLoad: vi.fn(async (name: string) => ({ value: disk[name] ?? null, recoveredFrom: null })),
  storeSave: vi.fn(async (name: string, v: unknown) => void (disk[name] = JSON.parse(JSON.stringify(v)))),
  uiLog: vi.fn(async () => {}),
}));

import * as tauri from "../src/lib/tauri";
import { FEATURES } from "../src/lib/features";
import { emitProfileDeleted } from "../src/lib/owner";
import { getTrakt, loadTraktStoreForTests, startTraktConnect, traktScrobble, traktSyncNow } from "../src/lib/trakt";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const tokens = { access_token: "a".repeat(40), refresh_token: "b".repeat(40), expires_at: Date.now() + 86_400_000 };

describe("Trakt while temporarily disabled", () => {
  it("ships switched off", () => {
    expect(FEATURES.trakt).toBe(false);
  });

  it("never contacts Trakt or the relay, even for a connected profile", async () => {
    loadTraktStoreForTests({ v: 2, profiles: { [A]: { tokens } } }, A);
    await startTraktConnect();
    await traktSyncNow();
    expect(await traktScrobble("start", { type: "movie", metaId: "tt0111161" }, 5)).toBe(false);
    expect(getTrakt().phase.kind).toBe("idle");
    expect(getTrakt().error).toBeNull();
    expect(tauri.http).not.toHaveBeenCalled();
  });

  it("keeps stored connections, and forgets a deleted profile's without a revoke request", async () => {
    loadTraktStoreForTests({ v: 2, profiles: { [A]: { tokens }, [B]: { tokens } } }, A);
    emitProfileDeleted(B);
    await vi.waitFor(() => expect(tauri.storeSave).toHaveBeenCalled());
    const saved = disk.trakt as { profiles: Record<string, unknown> };
    expect(saved.profiles[A]).toEqual({ tokens });
    expect(saved.profiles[B]).toBeUndefined();
    expect(tauri.http).not.toHaveBeenCalled();
  });
});
