import { beforeEach, describe, expect, it, vi } from "vitest";

const disk: Record<string, unknown> = {};
vi.mock("../src/lib/tauri", () => ({
  http: vi.fn(),
  httpJson: vi.fn(async (url: string) => ({ id: url, name: url, version: "1", resources: [], types: [], catalogs: [] })),
  storeLoad: vi.fn(async (name: string) => ({ value: disk[name] ?? null, recoveredFrom: null })),
  storeSave: vi.fn(async (name: string, v: unknown) => void (disk[name] = JSON.parse(JSON.stringify(v)))),
  uiLog: vi.fn(async () => {}),
}));

const U = "99999999-9999-4999-8999-999999999999";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let pinOnServer = true;
const paths: string[] = [];
vi.mock("../src/lib/account", async (orig) => {
  const real = await orig<typeof import("../src/lib/account")>();
  return {
    ...real,
    getAccount: () => ({ status: "signedIn", userId: U }),
    subscribeAccount: () => () => {},
    signOut: async () => {},
    authedRequest: async (path: string) => {
      paths.push(path);
      let body: unknown = [];
      if (path.startsWith("/rest/v1/profiles?select")) body = [{ id: A, name: "Ana", avatar: "sunny", created_at: "2026-01-01" }];
      if (path === "/rest/v1/rpc/profile_pin_status") body = [{ profile_id: A, has_pin: pinOnServer }];
      return { status: 200, body: JSON.stringify(body) };
    },
  };
});

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  vi.resetModules();
  paths.length = 0;
});

async function launch(cachedPin: boolean, serverPin: boolean) {
  pinOnServer = serverPin;
  disk.profile = {
    v: 1, userId: U, profileId: A, owner: A, profiles: [{ id: A, name: "Ana", avatar: "sunny", created_at: "2026-01-01" }],
    caches: {}, merged: [U], accountSeen: {}, pins: cachedPin ? { [A]: true } : {},
  };
  const sync = await import("../src/lib/sync");
  await sync.initSync();
  return sync;
}

describe("auto-open of the last profile at launch", () => {
  it("asks for the PIN instead of opening a PIN profile", async () => {
    const { getSync } = await launch(true, true);
    expect(getSync().active).toBeNull();
    expect(getSync().pinPrompt).toBe(A);
    await settle();
    expect(getSync().active).toBeNull();
    expect(paths.some((p) => p.includes("profile_data"))).toBe(false); // nothing synced before the PIN
  });

  it("opens it after all when the PIN was removed on another device", async () => {
    const { getSync } = await launch(true, false);
    await settle();
    expect(getSync().pinPrompt).toBeNull();
    expect(getSync().active?.id).toBe(A);
  });

  it("locks again when a PIN was added on another device", async () => {
    const { getSync } = await launch(false, true);
    await settle();
    expect(getSync().active).toBeNull();
    expect(getSync().pinPrompt).toBe(A);
  });

  it("opens a profile without a PIN as before", async () => {
    const { getSync } = await launch(false, false);
    await settle();
    expect(getSync().active?.id).toBe(A);
    expect(getSync().pinPrompt).toBeNull();
  });
});
