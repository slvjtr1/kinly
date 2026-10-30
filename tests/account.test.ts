import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/tauri", () => ({
  http: vi.fn(),
  storeLoad: vi.fn(async () => ({ value: null, recoveredFrom: null })),
  storeSave: vi.fn(async () => {}),
  uiLog: vi.fn(async () => {}),
}));

import * as tauri from "../src/lib/tauri";
import {
  authError, backoffDelayMs, checkPassword, decodeJwt, getAccount, isJwtExpired, normalizeEmail, parseAccountDoc, parseSession, signIn, signInWaitMs,
  signUp,
} from "../src/lib/account";
import { SUPABASE_URL } from "../src/lib/supabaseConfig";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "6f1c2b9e-3d4a-4b5c-8d7e-0123456789ab";
export const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "ES256", typ: "JWT" })}.${b64url(claims)}.c2lnbmF0dXJl`;
const valid = (expSec: number) => jwt({ sub: UID, exp: expSec, iss: `${SUPABASE_URL}/auth/v1`, aud: "authenticated" });

describe("password policy", () => {
  it("requires 10+ characters", () => {
    expect(checkPassword("Ab1!xyz").ok).toBe(false);
    expect(checkPassword("Ab1!xyz").problems[0]).toMatch(/10 characters/);
    expect(checkPassword("Tide-pool-42").ok).toBe(true);
  });
  it("rejects a single character class", () => {
    expect(checkPassword("abcdefghijkl").ok).toBe(false);
    expect(checkPassword("123456789012").ok).toBe(false);
    expect(checkPassword("abcdefghij12").ok).toBe(true);
  });
  it("rejects common passwords regardless of case and trailing symbols", () => {
    for (const p of ["Password123", "Qwerty1234", "iloveyou12", "password1!", "Welcome123"]) expect(checkPassword(p).ok, p).toBe(false);
  });
  it("rejects repeated characters and the email's name", () => {
    expect(checkPassword("aaaaaaaaaaaa").ok).toBe(false);
    expect(checkPassword("Konrad-2026!", "konrad@example.com").ok).toBe(false);
  });
  it("rejects passwords above the bcrypt limit", () => {
    expect(checkPassword("Aa1" + "x".repeat(80)).ok).toBe(false);
  });
  it("scores strength", () => {
    expect(checkPassword("").score).toBe(0);
    expect(checkPassword("abc").score).toBeLessThanOrEqual(1);
    expect(checkPassword("harbor-lights7").score).toBeGreaterThanOrEqual(2);
    expect(checkPassword("Harbor-Lights-at-Dawn-77").score).toBe(4);
  });
});

describe("email", () => {
  it("trims, lowercases the domain and validates", () => {
    expect(normalizeEmail("  Ana@Example.COM ")).toBe("Ana@example.com");
    expect(normalizeEmail("no-at-sign")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail("a b@c.de")).toBeNull();
    expect(normalizeEmail(`${"x".repeat(65)}@example.com`)).toBeNull();
  });
});

describe("JWT", () => {
  it("decodes the claims and checks issuer and subject", () => {
    expect(decodeJwt(valid(2_000_000_000))?.sub).toBe(UID);
    expect(decodeJwt(jwt({ sub: UID, exp: 2_000_000_000, iss: "https://evil.example/auth/v1" }))).toBeNull();
    expect(decodeJwt(jwt({ sub: "not-a-uuid", exp: 2_000_000_000 }))).toBeNull();
    expect(decodeJwt(jwt({ sub: UID }))).toBeNull();
    expect(decodeJwt("abc")).toBeNull();
    expect(decodeJwt("a.%%%.c")).toBeNull();
  });
  it("treats tokens close to expiry as expired", () => {
    const now = 1_700_000_000_000;
    expect(isJwtExpired(valid(now / 1000 + 3600), now)).toBe(false);
    expect(isJwtExpired(valid(now / 1000 + 10), now)).toBe(true); // inside the 30 s skew
    expect(isJwtExpired(valid(now / 1000 - 1), now)).toBe(true);
    expect(isJwtExpired("garbage", now)).toBe(true);
  });
});

describe("sessions", () => {
  it("keeps only the tokens and expiry, taking the earlier expiry", () => {
    const s = parseSession({ access_token: valid(2_000_000_000), refresh_token: "r3fr3sh", expires_at: 1_999_999_000, user: { email: "a@b.co" } });
    expect(s).toEqual({ access_token: valid(2_000_000_000), refresh_token: "r3fr3sh", expires_at: 1_999_999_000 });
    expect(parseSession({ access_token: "x", refresh_token: "r" })).toBeNull();
    expect(parseSession({ access_token: valid(2_000_000_000), refresh_token: "has space" })).toBeNull();
  });
  it("parses the stored doc defensively", () => {
    expect(parseAccountDoc(null)).toBeNull();
    expect(parseAccountDoc({ guest: true, password: "x" })).toEqual({ v: 1, guest: true });
    expect(parseAccountDoc({ session: { access_token: "bad", refresh_token: "r", expires_at: 1 } })).toEqual({ v: 1 });
  });
});

describe("backoff", () => {
  it("grows exponentially and caps at 5 minutes", () => {
    expect(backoffDelayMs(1)).toBe(0);
    expect(backoffDelayMs(2)).toBe(2000);
    expect(backoffDelayMs(3)).toBe(4000);
    expect(backoffDelayMs(20)).toBe(300_000);
  });
});

describe("auth errors are generic", () => {
  it("never echoes server text", () => {
    const e = authError({ status: 400, body: JSON.stringify({ error_code: "invalid_credentials", msg: "no user ana@example.com" }) }, "signin");
    expect(e.message).not.toMatch(/ana@example/);
    expect(authError({ status: 429, body: "" }, "signin").code).toBe("rate");
  });
});

describe("sign-in flow (mocked HTTP)", () => {
  beforeEach(() => vi.mocked(tauri.http).mockReset());

  it("backs off after repeated failures, then stores only tokens on success", async () => {
    vi.mocked(tauri.http).mockResolvedValue({ status: 400, body: '{"error_code":"invalid_credentials"}' });
    await expect(signIn("ana@example.com", "wrong-password-1")).rejects.toThrow(/Couldn't sign in/);
    await expect(signIn("ana@example.com", "wrong-password-1")).rejects.toThrow(/Couldn't sign in/);
    expect(signInWaitMs()).toBeGreaterThan(0);
    await expect(signIn("ana@example.com", "wrong-password-1")).rejects.toThrow(/Too many failed attempts/);
    expect(tauri.http).toHaveBeenCalledTimes(2);
  });

  it("answers sign-up for an existing address exactly like a new one", async () => {
    vi.mocked(tauri.http).mockResolvedValue({ status: 422, body: '{"error_code":"user_already_exists"}' });
    await expect(signUp("ana@example.com", "Tide-pool-42")).resolves.toBe("confirm");
    vi.mocked(tauri.http).mockResolvedValue({ status: 200, body: JSON.stringify({ id: UID, email: "ana@example.com" }) });
    await expect(signUp("ana@example.com", "Tide-pool-42")).resolves.toBe("confirm");
    await expect(signUp("ana@example.com", "password123")).rejects.toThrow(/common/);
  });

  it("stores the session without email or password", async () => {
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000 }); // past the backoff from the first test
    vi.mocked(tauri.http).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ access_token: valid(Math.floor(Date.now() / 1000) + 3600), refresh_token: "rt-1", expires_in: 3600, user: { id: UID, email: "ana@example.com" } }),
    });
    await signIn(" ana@example.com ", "Tide-pool-42");
    const saved = vi.mocked(tauri.storeSave).mock.calls.at(-1)!;
    expect(saved[0]).toBe("account");
    const json = JSON.stringify(saved[1]);
    expect(json).not.toMatch(/ana@example|Tide-pool/);
    expect(Object.keys((saved[1] as { session: object }).session).sort()).toEqual(["access_token", "expires_at", "refresh_token"]);
    expect(getAccount()).toMatchObject({ status: "signedIn", userId: UID });
    const body = JSON.parse(vi.mocked(tauri.http).mock.calls[0][1]!.body!);
    expect(body.email).toBe("ana@example.com"); // trimmed
    vi.useRealTimers();
  });
});

import { AVATAR_URL_MAX, avatarOk, isAvatarUrl } from "../src/lib/account";

describe("profile avatar validation (mirrors profiles_avatar_check)", () => {
  it("accepts built-in keys and public https image links", () => {
    for (const v of ["ocean", "sunny", "a-1", "x".repeat(24)]) expect(avatarOk(v)).toBe(true);
    for (const v of [
      "https://example.com/me.png",
      "https://cdn.example.co.uk:8443/a/b/c.JPEG?size=256&v=2",
      "https://Img.Example.com/x.webp",
      "https://i.example.com/cat.gif",
      "https://example.com/a%20b.jpg",
    ]) {
      expect(isAvatarUrl(v), v).toBe(true);
      expect(avatarOk(v), v).toBe(true);
    }
  });

  it("rejects everything the server rejects", () => {
    for (const v of [
      "",
      "Ocean",
      "x".repeat(25),
      "http://example.com/me.png", // not https
      "https://example.com/me.svg",
      "https://example.com/me.png#frag",
      "https://example.com/me.pngx",
      "https://example.com", // no path
      "https://exa mple.com/a.png",
      "https://example.com/a b.png",
      'https://example.com/"onerror=.png',
      "https://example.com/<x>.png",
      "https://example.com/a\\b.png",
      "https://user@example.com/a.png",
      "https://example.com:1/a.png", // port must be 2-5 digits
      "javascript:alert(1)//.png",
      "data:image/png;base64,AAAA.png",
      `https://example.com/${"a".repeat(AVATAR_URL_MAX)}.png`, // too long
    ]) expect(avatarOk(v), v).toBe(false);
  });
});
