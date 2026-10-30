// Opt-in checks against the real Supabase project: KINLY_LIVE=1 npx vitest run tests/supabase-live.test.ts
// They send no email and create nothing.
import { describe, expect, it } from "vitest";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../src/lib/supabaseConfig";

const live = !!process.env.KINLY_LIVE;
const h = { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" };

describe.skipIf(!live)("Supabase project (live)", { timeout: 20_000 }, () => {
  it.each(["profiles", "account_data", "profile_data"])("anon cannot read %s", async (t) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*`, { headers: h });
    const body = await r.text();
    expect(r.status === 401 || body === "[]").toBe(true);
  });
  it("anon cannot insert a profile", async () => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, { method: "POST", headers: h, body: JSON.stringify({ name: "x", avatar: "ocean" }) });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  it("anon cannot read profile PIN hashes", async () => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profile_pins?select=*`, { headers: h });
    const body = await r.text();
    expect(r.status === 401 || r.status === 404 || body === "[]").toBe(true);
  });
  it.each([
    ["profile_pin_status", {}],
    ["verify_profile_pin", { p_profile: "00000000-0000-4000-8000-000000000000", p_pin: "1234" }],
    ["set_profile_pin", { p_profile: "00000000-0000-4000-8000-000000000000", p_pin: "1234", p_current: null }],
  ])("anon cannot call %s (it exists, but only for signed-in users)", async (fn, body) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: h, body: JSON.stringify(body) });
    expect(r.status).toBe(401);
  });
  it("a wrong sign-in is a generic 400", async () => {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ email: "nobody-kinly-smoke@example.invalid", password: "Not-a-real-pass-1" }),
    });
    expect(r.status).toBe(400);
  });
});
