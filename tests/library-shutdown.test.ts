import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", globalThis);
const saved: { name: string; value: unknown }[] = [];
vi.mock("../src/lib/tauri", () => ({
  storeLoad: vi.fn(async () => ({ value: null, recoveredFrom: null })),
  storeSave: vi.fn(async (name: string, value: unknown) => void saved.push({ name, value: JSON.parse(JSON.stringify(value)) })),
}));

import { loadLibrary, saveProgress, toggleWatchlist } from "../src/lib/library";
import { onShutdown, runShutdown } from "../src/lib/shutdown";

describe("closing the app", () => {
  it("writes library changes still waiting for the debounce, including a position captured at close", async () => {
    await loadLibrary();
    toggleWatchlist({ id: "tt1", type: "movie", name: "One" });
    const off = onShutdown(() => saveProgress({ key: "movie:tt1", metaId: "tt1", type: "movie", name: "One", videoId: "tt1", position: 600, duration: 6000 }, 0.9), "capture");
    saved.length = 0;
    await runShutdown();
    off();
    expect(saved).toHaveLength(1);
    const lib = saved[0].value as { watchlist: { id: string }[]; progress: Record<string, { position: number }> };
    expect(saved[0].name).toBe("library");
    expect(lib.watchlist.map((w) => w.id)).toEqual(["tt1"]);
    expect(lib.progress["movie:tt1"].position).toBe(600);
  });

  it("does not rewrite the library when nothing is pending", async () => {
    saved.length = 0;
    await runShutdown();
    expect(saved).toEqual([]);
  });
});
