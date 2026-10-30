import { beforeEach, describe, expect, it, vi } from "vitest";

const PRIMARY = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Ana", avatar: "sunny" };
const NEW = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Kid", avatar: "sunny" };
let pins: Record<string, boolean> = {};
const verifyPin = vi.fn();
const setPin = vi.fn();
const createProfile = vi.fn(async () => NEW);
const notePinChanged = vi.fn();
const copyTraktConnection = vi.fn(async () => true);
const copyTmdbConnection = vi.fn(async () => true);

vi.mock("../src/lib/pins", async (orig) => ({ ...(await orig<typeof import("../src/lib/pins")>()), verifyPin: (...a: unknown[]) => verifyPin(...a), setPin: (...a: unknown[]) => setPin(...a) }));
vi.mock("../src/lib/sync", () => ({
  createProfile: (...a: unknown[]) => createProfile(...(a as [])),
  getSync: () => ({ pins }),
  notePinChanged: (...a: unknown[]) => notePinChanged(...a),
  primaryProfile: () => PRIMARY,
}));
vi.mock("../src/lib/trakt", () => ({ copyTraktConnection: (...a: unknown[]) => copyTraktConnection(...(a as [])) }));
vi.mock("../src/lib/tmdb", () => ({ copyTmdbConnection: (...a: unknown[]) => copyTmdbConnection(...(a as [])) }));

import { createProfileWithOptions, needsPrimaryPin } from "../src/lib/profileCreate";
import { resetPinBookkeeping } from "../src/lib/pins";

beforeEach(() => {
  pins = {};
  resetPinBookkeeping();
  for (const f of [verifyPin, setPin, createProfile, notePinChanged, copyTraktConnection, copyTmdbConnection]) f.mockClear();
});

describe("create-profile options", () => {
  it("defaults: copies the primary's addons, not its connections, no PIN check without a primary PIN", async () => {
    const r = await createProfileWithOptions("Kid", "sunny", { copyAddons: true, copyConnections: false });
    expect(r).toEqual({ profile: NEW, warning: undefined });
    expect(createProfile).toHaveBeenCalledWith("Kid", "sunny", { copyAddonsFrom: PRIMARY.id });
    expect(verifyPin).not.toHaveBeenCalled();
    expect(copyTraktConnection).not.toHaveBeenCalled();
  });

  it("unchecked addons means defaults (no copy source)", async () => {
    await createProfileWithOptions("Kid", "sunny", { copyAddons: false, copyConnections: false });
    expect(createProfile).toHaveBeenCalledWith("Kid", "sunny", { copyAddonsFrom: null });
  });

  it("copies Trakt and TMDB connections to the new profile", async () => {
    await createProfileWithOptions("Kid", "sunny", { copyAddons: false, copyConnections: true });
    expect(copyTraktConnection).toHaveBeenCalledWith(PRIMARY.id, NEW.id);
    expect(copyTmdbConnection).toHaveBeenCalledWith(PRIMARY.id, NEW.id);
    expect(createProfile).toHaveBeenCalledWith("Kid", "sunny", { copyAddonsFrom: null });
  });

  it("needs the primary's PIN to copy from a locked primary, and creates nothing when it's wrong or locked", async () => {
    pins = { [PRIMARY.id]: true };
    expect(needsPrimaryPin({ copyAddons: false, copyConnections: false })).toBe(false);
    expect(needsPrimaryPin({ copyAddons: true, copyConnections: false })).toBe(true);

    verifyPin.mockResolvedValueOnce("wrong");
    await expect(createProfileWithOptions("Kid", "sunny", { copyAddons: true, copyConnections: true, primaryPin: "1111" })).rejects.toThrow(/Ana: Wrong PIN/);
    verifyPin.mockResolvedValueOnce("locked");
    await expect(createProfileWithOptions("Kid", "sunny", { copyAddons: true, copyConnections: false, primaryPin: "1111" })).rejects.toThrow(/locked; try again in \d+ min/);
    expect(createProfile).not.toHaveBeenCalled();
    expect(copyTraktConnection).not.toHaveBeenCalled();

    verifyPin.mockResolvedValueOnce("ok");
    await createProfileWithOptions("Kid", "sunny", { copyAddons: true, copyConnections: true, primaryPin: "2468" });
    expect(verifyPin).toHaveBeenLastCalledWith(PRIMARY.id, "2468");
    expect(createProfile).toHaveBeenCalledTimes(1);
    expect(copyTraktConnection).toHaveBeenCalledTimes(1);
  });

  it("doesn't ask for the primary's PIN when nothing is copied", async () => {
    pins = { [PRIMARY.id]: true };
    await createProfileWithOptions("Kid", "sunny", { copyAddons: false, copyConnections: false });
    expect(verifyPin).not.toHaveBeenCalled();
  });

  it("sets the new profile's PIN, and reports (without failing) when that step fails", async () => {
    setPin.mockResolvedValueOnce("ok");
    await createProfileWithOptions("Kid", "sunny", { copyAddons: true, copyConnections: false, pin: "123456" });
    expect(setPin).toHaveBeenCalledWith(NEW.id, "123456");
    expect(notePinChanged).toHaveBeenCalledWith(NEW.id, true);
    setPin.mockRejectedValueOnce(new Error("offline"));
    const r = await createProfileWithOptions("Kid", "sunny", { copyAddons: true, copyConnections: false, pin: "123456" });
    expect(r.warning).toMatch(/PIN couldn't be set/);
    await expect(createProfileWithOptions("Kid", "sunny", { copyAddons: true, copyConnections: false, pin: "12" })).rejects.toThrow(/4 to 8/);
  });
});
