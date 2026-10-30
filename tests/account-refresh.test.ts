import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/tauri", () => ({
  http: vi.fn(),
  storeLoad: vi.fn(async () => ({ value: null, recoveredFrom: null })),
  storeSave: vi.fn(async () => {}),
  uiLog: vi.fn(async () => {}),
}));

import * as tauri from "../src/lib/tauri";
import { getAccount, refreshSession, signIn, signOut } from "../src/lib/account";
import { SUPABASE_URL } from "../src/lib/supabaseConfig";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "6f1c2b9e-3d4a-4b5c-8d7e-0123456789ab";
const token = (expSec: number) =>
  `${b64url({ alg: "ES256", typ: "JWT" })}.${b64url({ sub: UID, exp: expSec, iss: `${SUPABASE_URL}/auth/v1` })}.c2ln`;
const now = () => Math.floor(Date.now() / 1000);
const ok = (refresh: string) => ({ status: 200, body: JSON.stringify({ access_token: token(now() + 3600), refresh_token: refresh, expires_in: 3600 }) });

describe("session refresh racing a sign-out", () => {
  it("does not sign back in when the refresh answer arrives after signing out", async () => {
    const http = vi.mocked(tauri.http);
    http.mockResolvedValueOnce(ok("r1"));
    await signIn("someone@example.com", "Tide-pool-42");
    expect(getAccount().status).toBe("signedIn");

    let answer!: (v: { status: number; body: string }) => void;
    http.mockImplementation(async (url: string) => {
      if (url.includes("grant_type=refresh_token")) return new Promise((r) => (answer = r));
      return { status: 204, body: "" }; // logout
    });
    const pending = refreshSession();
    await signOut();
    expect(getAccount().status).toBe("undecided");

    answer(ok("r2"));
    await expect(pending).resolves.toBeNull();
    expect(getAccount().status).toBe("undecided");
  });

  it("a late rejection does not sign out a newer session", async () => {
    const http = vi.mocked(tauri.http);
    http.mockReset();
    http.mockResolvedValueOnce(ok("a1"));
    await signIn("someone@example.com", "Tide-pool-42");

    let answer!: (v: { status: number; body: string }) => void;
    http.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const pending = refreshSession();
    // Signed out and in again while the first refresh was out.
    http.mockResolvedValueOnce({ status: 204, body: "" }).mockResolvedValueOnce(ok("b1"));
    await signOut();
    await signIn("someone@example.com", "Tide-pool-42");

    answer({ status: 400, body: JSON.stringify({ error_code: "refresh_token_not_found" }) });
    await pending.catch(() => {});
    expect(getAccount().status).toBe("signedIn");
  });
});
