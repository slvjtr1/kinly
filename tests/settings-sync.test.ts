import { describe, expect, it, vi } from "vitest";

// The settings hook only uses useEffect; run effects immediately so it can be driven without a renderer.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (fn: () => void) => void fn() }));

const disk: Record<string, unknown> = {};
vi.mock("../src/lib/tauri", () => ({
  http: vi.fn(),
  httpJson: vi.fn(),
  storeLoad: vi.fn(async (name: string) => ({ value: disk[name] ?? null, recoveredFrom: null })),
  storeSave: vi.fn(async (name: string, v: unknown) => void (disk[name] = JSON.parse(JSON.stringify(v)))),
  uiLog: vi.fn(async () => {}),
}));

const U = "99999999-9999-4999-8999-999999999999";
type Req = { method?: string; body?: Record<string, unknown> };
let route: (path: string, init: Req) => unknown = () => [];
const patches: Record<string, unknown>[] = [];
vi.mock("../src/lib/account", async (orig) => ({
  ...(await orig<typeof import("../src/lib/account")>()),
  getAccount: () => ({ status: "signedIn", userId: U }),
  subscribeAccount: () => () => {},
  authedRequest: async (path: string, init: Req = {}) => {
    const body = route(path, init);
    return { status: 200, body: body === undefined ? "" : JSON.stringify(body) };
  },
}));

import { DEFAULT_SETTINGS, type Settings } from "../src/lib/settings";
import { initSync, syncNow, useCloudSettings } from "../src/lib/sync";

const withTheme = (theme: Settings["appearance"]["theme"]): Settings => ({ ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, theme } });

describe("account settings sync", () => {
  it("uploads a change made while an earlier upload was on the network", async () => {
    let at = "2026-10-30T10:00:00.000000+00:00";
    let remote: unknown = { appearance: { theme: "kinly" } };
    let duringUpload: (() => void) | null = null;
    route = (path, init) => {
      if (path.startsWith("/rest/v1/account_data")) {
        if (init.method === "PATCH") {
          patches.push(init.body!);
          duringUpload?.();
          duringUpload = null;
          remote = init.body!.settings;
          at = `2026-10-30T10:00:0${patches.length}.000000+00:00`;
          return [{ updated_at: at }];
        }
        return [{ settings: remote, updated_at: at }];
      }
      return [];
    };
    disk.profile = { v: 1, userId: U, owner: "guest", caches: {}, merged: [U], accountSeen: { [U]: at }, addons: {}, pins: {} };
    await initSync();

    const update = vi.fn();
    useCloudSettings(withTheme("kinly"), update);
    useCloudSettings(withTheme("ocean"), update); // edited: marked dirty
    // While that upload is out, the user changes the theme again.
    duringUpload = () => useCloudSettings(withTheme("dusk"), update);
    await syncNow();
    expect(patches.map((p) => (p.settings as Settings).appearance.theme)).toEqual(["ocean"]);

    await syncNow();
    expect(patches.map((p) => (p.settings as Settings).appearance.theme)).toEqual(["ocean", "dusk"]);
  });
});
