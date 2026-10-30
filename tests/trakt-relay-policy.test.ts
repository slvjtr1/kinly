import { describe, expect, it } from "vitest";
import { MemoryLimiter, allowedKeys, clientIp, ipHash, keyAccepted } from "../supabase/functions/trakt-oauth/policy";

const h = (init: Record<string, string>) => new Headers(init);

describe("trakt relay policy", () => {
  it("takes the first X-Forwarded-For entry and rejects junk", () => {
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(h({ "x-forwarded-for": "<script>" }))).toBeNull();
    expect(clientIp(h({}))).toBeNull();
  });

  it("collects accepted keys from KINLY_CLIENT_KEYS and the runtime's publishable keys", () => {
    const env: Record<string, string> = {
      KINLY_CLIENT_KEYS: " sb_publishable_a , ,sb_publishable_b",
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_c" }),
    };
    expect([...allowedKeys((n) => env[n])].sort()).toEqual(["sb_publishable_a", "sb_publishable_b", "sb_publishable_c"]);
    expect(allowedKeys((n) => (n === "SUPABASE_PUBLISHABLE_KEYS" ? "not json" : undefined)).size).toBe(0);
  });

  it("requires an accepted apikey once keys are configured", () => {
    const keys = new Set(["sb_publishable_a"]);
    expect(keyAccepted(h({ apikey: "sb_publishable_a" }), keys)).toBe(true);
    expect(keyAccepted(h({ apikey: "sb_publishable_x" }), keys)).toBe(false);
    expect(keyAccepted(h({}), keys)).toBe(false);
    expect(keyAccepted(h({}), new Set())).toBe(true);
  });

  it("limits each key per window and starts over in the next one", () => {
    const l = new MemoryLimiter(2, 60_000);
    expect([l.allow("a", 0), l.allow("a", 1), l.allow("a", 2), l.allow("b", 3)]).toEqual([true, true, false, true]);
    expect(l.allow("a", 60_000)).toBe(true);
  });

  it("stays bounded under many distinct keys", () => {
    const l = new MemoryLimiter(5, 60_000, 3);
    expect(["a", "b", "c"].map((k) => l.allow(k, 0))).toEqual([true, true, true]);
    expect(l.allow("d", 1)).toBe(false); // full within the current window
    expect(l.allow("d", 60_000)).toBe(true); // stale windows are evicted
  });

  it("hashes IPs with a salt into the format the database accepts", async () => {
    const a = await ipHash("203.0.113.7", "s1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(await ipHash("203.0.113.7", "s2"));
  });
});
