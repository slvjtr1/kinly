import { beforeEach, describe, expect, it, vi } from "vitest";

const authedRequest = vi.fn();
vi.mock("../src/lib/account", () => ({ authedRequest: (...a: unknown[]) => authedRequest(...a) }));

import { lockMinutesLeft, parsePinStatus, pinInput, pinMessage, pinOk, resetPinBookkeeping, setPin, verifyPin } from "../src/lib/pins";

const P = "11111111-2222-4333-8444-555555555555";
const reply = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });

describe("PIN validation", () => {
  it("accepts 4 to 8 digits only", () => {
    expect(["1234", "12345678"].every(pinOk)).toBe(true);
    expect(["123", "123456789", "12a4", " 1234", ""].some(pinOk)).toBe(false);
    expect(pinInput("12-34 56789")).toBe("12345678");
  });
  it("parses profile_pin_status rows and drops junk", () => {
    expect(parsePinStatus([{ profile_id: P, has_pin: true }, { profile_id: "x", has_pin: true }, { profile_id: P.replace("1", "9"), has_pin: false }, null])).toEqual({
      [P]: true,
      [P.replace("1", "9")]: false,
    });
    expect(parsePinStatus({})).toBeNull();
  });
});

describe("PIN flow with mocked http", () => {
  beforeEach(() => {
    authedRequest.mockReset();
    resetPinBookkeeping();
  });

  it("verifies through the RPC and never sends a malformed PIN", async () => {
    authedRequest.mockResolvedValueOnce(reply("ok"));
    expect(await verifyPin(P, "1234")).toBe("ok");
    expect(authedRequest).toHaveBeenCalledWith("/rest/v1/rpc/verify_profile_pin", { method: "POST", body: { p_profile: P, p_pin: "1234" } });
    expect(await verifyPin(P, "12")).toBe("wrong");
    expect(authedRequest).toHaveBeenCalledTimes(1);
  });

  it("goes wrong → locked and estimates the time left from the last wrong guess", async () => {
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 5; i++) authedRequest.mockResolvedValueOnce(reply("wrong"));
    for (let i = 0; i < 5; i++) expect(await verifyPin(P, "0000", t0 + i * 1000)).toBe("wrong");
    expect(pinMessage(P, "wrong")).toMatch(/Wrong PIN/);
    authedRequest.mockResolvedValueOnce(reply("locked"));
    const now = t0 + 4000 + 60_000;
    expect(await verifyPin(P, "0000", now)).toBe("locked");
    expect(lockMinutesLeft(P, now)).toBe(4);
    expect(pinMessage(P, "locked", now)).toBe("Too many wrong PINs. This profile is locked; try again in 4 min.");
    // After the lock, a right PIN resets the bookkeeping.
    authedRequest.mockResolvedValueOnce(reply("ok"));
    expect(await verifyPin(P, "4321", now + 300_000)).toBe("ok");
    expect(lockMinutesLeft(P, now + 300_000)).toBe(5);
  });

  it("shows at least a minute for a lock it didn't see start", async () => {
    authedRequest.mockResolvedValueOnce(reply("locked"));
    expect(await verifyPin(P, "1234", 5)).toBe("locked");
    expect(pinMessage(P, "locked", 5)).toMatch(/try again in 5 min/);
  });

  it("sets, changes and removes a PIN", async () => {
    authedRequest.mockResolvedValue(reply("ok"));
    expect(await setPin(P, "1234")).toBe("ok");
    expect(authedRequest.mock.calls[0][1].body).toEqual({ p_profile: P, p_pin: "1234", p_current: null });
    await setPin(P, "5678", "1234");
    expect(authedRequest.mock.calls[1][1].body).toEqual({ p_profile: P, p_pin: "5678", p_current: "1234" });
    await setPin(P, null, "5678");
    expect(authedRequest.mock.calls[2][1].body).toEqual({ p_profile: P, p_pin: null, p_current: "5678" });
    // Forgot PIN: after a fresh password sign-in, no current PIN is sent.
    await setPin(P, null);
    expect(authedRequest.mock.calls[3][1].body).toEqual({ p_profile: P, p_pin: null, p_current: null });
  });

  it("rejects bad PINs locally and maps server verdicts", async () => {
    expect(await setPin(P, "12")).toBe("invalid");
    expect(authedRequest).not.toHaveBeenCalled();
    authedRequest.mockResolvedValueOnce(reply("wrong"));
    expect(await setPin(P, "1234", "9999")).toBe("wrong");
    authedRequest.mockResolvedValueOnce(reply("invalid"));
    expect(await setPin(P, "1234")).toBe("invalid");
    authedRequest.mockResolvedValueOnce(reply("weird"));
    await expect(setPin(P, "1234")).rejects.toThrow(/Unexpected/);
  });

  it("turns HTTP and network failures into friendly errors", async () => {
    authedRequest.mockResolvedValueOnce({ status: 400, body: '{"message":"not allowed"}' });
    await expect(verifyPin(P, "1234")).rejects.toThrow(/Couldn't check the PIN/);
    authedRequest.mockRejectedValueOnce(new Error("offline"));
    await expect(verifyPin(P, "1234")).rejects.toThrow(/connection/);
    await expect(verifyPin("nope", "1234")).rejects.toThrow(/Unknown profile/);
  });
});
