import { beforeEach, describe, expect, it, vi } from "vitest";

const U = "99999999-9999-4999-8999-999999999999";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const disk: Record<string, unknown> = {};
const steps: string[] = [];
let rpcAnswer: unknown = "ok";
let signedIn = true;

vi.mock("../src/lib/tauri", () => ({
  http: vi.fn(),
  httpJson: vi.fn(),
  storeLoad: vi.fn(async (name: string) => ({ value: disk[name] ?? null, recoveredFrom: null })),
  storeSave: vi.fn(async (name: string, v: unknown) => void (disk[name] = JSON.parse(JSON.stringify(v)))),
  uiLog: vi.fn(async () => {}),
}));
vi.mock("../src/lib/account", async (orig) => {
  const real = await orig<typeof import("../src/lib/account")>();
  return {
    ...real,
    getAccount: () => (signedIn ? { status: "signedIn", userId: U } : { status: "undecided" }),
    subscribeAccount: () => () => {},
    reauthenticate: vi.fn(async (pw: string) => {
      steps.push(`reauth:${pw}`);
      if (pw !== "right") throw new Error("That password isn't right.");
    }),
    signOut: vi.fn(async () => {
      steps.push("signOut");
      signedIn = false;
    }),
    authedRequest: async (path: string, init: { method?: string } = {}) => {
      if (path === "/rest/v1/rpc/delete_my_account") {
        steps.push(`rpc:${init.method}`);
        return { status: 200, body: JSON.stringify(rpcAnswer) };
      }
      return { status: 200, body: "[]" };
    },
  };
});

import { deleteAccount, initSync } from "../src/lib/sync";

describe("deleting the account", () => {
  beforeEach(() => {
    steps.length = 0;
    signedIn = true;
    rpcAnswer = "ok";
  });

  it("checks the password before calling the server, and stops if it is wrong", async () => {
    await expect(deleteAccount("wrong")).rejects.toThrow(/password/);
    expect(steps).toEqual(["reauth:wrong"]);
  });

  it("keeps the session when the server asks for a fresh sign-in", async () => {
    rpcAnswer = "reauth";
    await expect(deleteAccount("right")).rejects.toThrow(/password/);
    expect(steps).toEqual(["reauth:right", "rpc:POST"]);
  });

  it("deletes on the server, forgets this device's copies, then signs out", async () => {
    disk.profile = {
      v: 1, userId: U, profileId: A, owner: "guest", profiles: [{ id: A, name: "Ana", avatar: "sunny" }],
      caches: { [A]: { userId: U, lib: { watchlist: [], progress: {}, tombstones: {} } } },
      merged: [U], accountSeen: { [U]: "2026-10-29T09:00:00Z" }, addons: { [A]: { userId: U, list: [] } }, pins: {},
    };
    await initSync();
    await deleteAccount("right");
    expect(steps).toEqual(["reauth:right", "rpc:POST", "signOut"]);
    const saved = disk.profile as { caches: object; addons: object; accountSeen: object; merged: string[] };
    expect(saved.caches).toEqual({});
    expect(saved.addons).toEqual({});
    expect(saved.accountSeen).toEqual({});
    expect(saved.merged).toEqual([]);
  });
});
