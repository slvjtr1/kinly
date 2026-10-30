import { describe, expect, it, vi } from "vitest";

const disk: Record<string, unknown> = {};
vi.mock("../src/lib/tauri", () => ({
  http: vi.fn(),
  httpJson: vi.fn(async (url: string) => ({ id: url, name: url, version: "1", resources: ["meta"], types: ["movie"], catalogs: [] })),
  storeLoad: vi.fn(async (name: string) => ({ value: disk[name] ?? null, recoveredFrom: null })),
  storeSave: vi.fn(async (name: string, v: unknown) => void (disk[name] = JSON.parse(JSON.stringify(v)))),
  uiLog: vi.fn(async () => {}),
}));

const U = "99999999-9999-4999-8999-999999999999";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
type Req = { method?: string; body?: Record<string, unknown> };
class Status {
  constructor(readonly code: number) {}
}
const calls: { path: string; init: Req }[] = [];
let route: (path: string, init: Req) => unknown = () => [];
vi.mock("../src/lib/account", async (orig) => {
  const real = await orig<typeof import("../src/lib/account")>();
  return {
    ...real,
    getAccount: () => ({ status: "signedIn", userId: U }),
    subscribeAccount: () => () => {},
    signOut: async () => {},
    authedRequest: async (path: string, init: Req = {}) => {
      calls.push({ path, init });
      const body = route(path, init);
      if (body instanceof Status) return { status: body.code, body: "" };
      return { status: 200, body: body === undefined ? "" : JSON.stringify(body) };
    },
  };
});

import { CINEMETA, OPENSUBTITLES } from "../src/lib/addons";
import { getLibrary, toggleWatchlist } from "../src/lib/library";
import { getOwner } from "../src/lib/owner";
import { createProfile, decideAddons, getSync, initSync, parseProfileStore, selectProfile, type Profile } from "../src/lib/sync";
import { getAddonsState, installAddon } from "../src/lib/useAddons";

const man = (id: string) => ({ id, name: id, version: "1", resources: ["stream"], types: ["movie"], catalogs: [] });
const LEGACY = "https://legacy.example/manifest.json";
const B_ADDON = "https://bonly.example/manifest.json";
const row = (id: string, name: string, created: string) => ({ id, name, avatar: "sunny", created_at: created });
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const posts = (prefix: string) => calls.filter((c) => c.init.method === "POST" && c.path.startsWith(prefix));

describe("addon reconcile (three-way)", () => {
  const j = (...u: string[]) => JSON.stringify(u);
  it("seeds a profile that has no list anywhere, and uploads a local list the server lacks", () => {
    expect(decideAddons({ local: null, remote: null, base: undefined })).toBe("seed");
    expect(decideAddons({ local: j("a"), remote: null, base: undefined })).toBe("local");
  });
  it("takes the server list on a new device", () => {
    expect(decideAddons({ local: null, remote: j("a"), base: undefined })).toBe("remote");
    expect(decideAddons({ local: j("b"), remote: j("a"), base: undefined })).toBe("remote");
  });
  it("keeps whichever side changed since the last agreed list", () => {
    expect(decideAddons({ local: j("a", "b"), remote: j("a"), base: j("a") })).toBe("local");
    expect(decideAddons({ local: j("a"), remote: j("a", "c"), base: j("a") })).toBe("remote");
    expect(decideAddons({ local: j("a"), remote: j("a"), base: j("x") })).toBe("same");
  });
  it("breaks a real conflict by time", () => {
    const base = j("a");
    expect(decideAddons({ local: j("b"), remote: j("c"), base, dirtyAt: Date.parse("2026-10-29T10:00:00Z"), remoteAt: "2026-10-29T09:00:00Z" })).toBe("local");
    expect(decideAddons({ local: j("b"), remote: j("c"), base, dirtyAt: Date.parse("2026-10-29T08:00:00Z"), remoteAt: "2026-10-29T09:00:00Z" })).toBe("remote");
  });
});

describe("profile store", () => {
  it("keeps valid per-profile addon caches and PIN flags only", () => {
    const d = parseProfileStore({
      owner: A,
      addons: { [A]: { userId: U, list: [{ transportUrl: CINEMETA }], base: "[]" }, nope: { userId: U, list: [] }, [B]: { userId: U, list: "x" } },
      pins: { [A]: true, [B]: "yes", bad: true },
    });
    expect(Object.keys(d.addons)).toEqual([A]);
    expect(d.pins).toEqual({ [A]: true });
  });
});

describe("standalone profiles (mocked cloud)", () => {
  it("seeds, isolates and copies per-profile addons and libraries, and gates PIN profiles", async () => {
    disk.profile = { v: 1, userId: U, profileId: A, owner: A, profiles: [row(A, "Ana", "2026-01-01"), row(B, "Ben", "2026-02-01")], caches: {}, merged: [U], accountSeen: {} };
    disk.addons = [{ transportUrl: CINEMETA, manifest: man("cinemeta") }]; // the guest list
    let tick = 0;
    const nextAt = () => `2026-10-29T09:${String(Math.floor(++tick / 60)).padStart(2, "0")}:${String(tick % 60).padStart(2, "0")}.123456+00:00`;
    const server: Record<string, { library: unknown; addons: unknown; at: string }> = {
      [A]: { library: { watchlist: [], progress: {}, tombstones: {} }, addons: null, at: nextAt() }, // created by an early beta build
      [B]: { library: { watchlist: [], progress: {}, tombstones: {} }, addons: [{ transportUrl: B_ADDON, manifest: man("b") }], at: nextAt() },
    };
    const write = (id: string, b: Record<string, unknown>) => {
      server[id] = { library: b.library ?? server[id]?.library ?? {}, addons: b.addons ?? server[id]?.addons ?? null, at: nextAt() };
      return [{ updated_at: server[id].at }];
    };
    route = (path, init) => {
      if (path.startsWith("/rest/v1/profiles?select")) {
        if (init.method === "POST") return [row("cccccccc-cccc-4ccc-8ccc-cccccccccccc", String(init.body!.name), "2026-03-01")];
        return [row(A, "Ana", "2026-01-01"), row(B, "Ben", "2026-02-01")];
      }
      if (path === "/rest/v1/rpc/profile_pin_status") return [{ profile_id: A, has_pin: false }, { profile_id: B, has_pin: true }];
      if (path.startsWith("/rest/v1/account_data?select=addons")) return [{ addons: [{ transportUrl: LEGACY, manifest: man("legacy") }] }];
      const m = path.match(/profile_data\?profile_id=eq\.([0-9a-f-]+)/);
      if (m && (!init.method || init.method === "GET")) {
        const r = server[m[1]];
        return r ? [{ library: r.library, addons: r.addons, updated_at: r.at }] : [];
      }
      if (m && init.method === "PATCH") {
        beforePatch?.(m[1], init.body!);
        const seen = decodeURIComponent(path.match(/updated_at=eq\.([^&]+)/)![1]);
        return server[m[1]]?.at === seen ? write(m[1], init.body!) : [];
      }
      if (path.startsWith("/rest/v1/profile_data?select") && init.method === "POST") {
        const id = String(init.body!.profile_id);
        return server[id] ? new Status(409) : write(id, init.body!);
      }
      if (path.startsWith("/rest/v1/profile_data?on_conflict") && init.method === "POST") return void write(String(init.body!.profile_id), init.body!);
      return [];
    };
    // Another device adds to Ana's watchlist between this device's read and its write.
    let beforePatch: ((id: string, body: Record<string, unknown>) => void) | null = null;

    await initSync();
    expect(getOwner()).toBe(A);
    await settle();

    // A had no list of its own: seeded from the beta-era account list, and uploaded.
    expect(getSync().active?.id).toBe(A);
    expect(getAddonsState()).toMatchObject({ status: "ready", owner: A });
    expect(getAddonsState().addons.map((a) => a.transportUrl)).toEqual([LEGACY]);
    expect((server[A].addons as { transportUrl: string }[]).map((a) => a.transportUrl)).toEqual([LEGACY]);
    // Addons are no longer written to account_data.
    expect(posts("/rest/v1/account_data").some((c) => "addons" in (c.init.body ?? {}))).toBe(false);

    // A's library change stays in A. A concurrent write from another device is merged, not overwritten.
    beforePatch = (id, body) => {
      if (id !== A || !body.library) return;
      beforePatch = null;
      write(A, { library: { watchlist: [{ id: "tt0000002", type: "movie", name: "Other device", addedAt: Date.now() - 1000 }], progress: {}, tombstones: {} } });
    };
    toggleWatchlist({ id: "tt0000001", type: "movie", name: "Only Ana" });
    expect(getLibrary().watchlist.map((w) => w.id)).toEqual(["tt0000001"]);

    // B has a PIN: it only opens after the PIN check.
    expect(getSync().pins[B]).toBe(true);
    const ben = getSync().profiles.find((p) => p.id === B) as Profile;
    await expect(selectProfile(ben)).rejects.toThrow(/PIN/);
    expect(getSync().active?.id).toBe(A);
    await selectProfile(ben, { pinVerified: true });
    await settle();
    expect(getOwner()).toBe(B);
    expect(getLibrary().watchlist).toEqual([]);
    expect(getAddonsState().addons.map((a) => a.transportUrl)).toEqual([B_ADDON]);

    // Installing in B changes B only.
    await installAddon("https://extra.example/manifest.json");
    await new Promise((r) => setTimeout(r, 3100));
    await settle();
    expect((server[B].addons as { transportUrl: string }[]).map((a) => a.transportUrl)).toEqual([B_ADDON, "https://extra.example/manifest.json"]);
    expect((server[A].addons as { transportUrl: string }[]).map((a) => a.transportUrl)).toEqual([LEGACY]);

    const ana = getSync().profiles.find((p) => p.id === A) as Profile;
    await selectProfile(ana);
    await settle();
    expect(beforePatch).toBeNull();
    expect(getLibrary().watchlist.map((w) => w.id)).toEqual(["tt0000001", "tt0000002"]);
    expect((server[A].library as { watchlist: { id: string }[] }).watchlist.map((w) => w.id)).toEqual(["tt0000001", "tt0000002"]);
    expect(getAddonsState().addons.map((a) => a.transportUrl)).toEqual([LEGACY]);

    // New profiles: copy the primary's addons, or start with the defaults.
    calls.length = 0;
    await createProfile("Copy", "sunny", { copyAddonsFrom: A });
    const copied = posts("/rest/v1/profile_data").at(-1)!.init.body!;
    expect((copied.addons as { transportUrl: string }[]).map((a) => a.transportUrl)).toEqual([LEGACY]);
    calls.length = 0;
    await createProfile("Fresh", "sunny");
    const fresh = posts("/rest/v1/profile_data").at(-1)!.init.body!;
    expect((fresh.addons as { transportUrl: string }[]).map((a) => a.transportUrl)).toEqual([CINEMETA, OPENSUBTITLES]);
  }, 15000);
});
