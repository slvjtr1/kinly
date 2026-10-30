import { beforeEach, describe, expect, it, vi } from "vitest";

const disk: Record<string, unknown> = {};
vi.mock("../src/lib/tauri", () => ({
  http: vi.fn(),
  httpJson: vi.fn(),
  storeLoad: vi.fn(async (name: string) => ({ value: disk[name] ?? null, recoveredFrom: null })),
  storeSave: vi.fn(async (name: string, v: unknown) => void (disk[name] = JSON.parse(JSON.stringify(v)))),
  uiLog: vi.fn(async () => {}),
}));

import * as tauri from "../src/lib/tauri";
import { emitProfileDeleted, setOwner } from "../src/lib/owner";
import { copyTmdbConnection, loadCredentials, migrateCredentials, parseCredentials, setTmdbKey, tmdbKey } from "../src/lib/tmdb";
import {
  cancelTraktConnect, copyTraktConnection, disconnectTrakt, getTrakt, hasTraktConnection, loadTraktStoreForTests, migrateTrakt, parseTraktStore, startTraktConnect,
  traktScrobble,
} from "../src/lib/trakt";
import { FEATURES } from "../src/lib/features";

// These tests cover the integration itself, which stays in the code while it is switched off.
FEATURES.trakt = true;

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_G = "fedcba9876543210fedcba9876543210";
const EXP = Date.now() + 30 * 86_400_000;
const tok = (c: string) => ({ access_token: c.repeat(40), refresh_token: c.toUpperCase().repeat(40), expires_at: EXP });
const ID = "i".repeat(64);
const SECRET = "s".repeat(64);

describe("TMDB credentials store", () => {
  it("parses v2 maps, drops bad owners and keys, and returns a v1 doc as legacy", () => {
    const v2 = parseCredentials({ v: 2, profiles: { [A]: { tmdb: { key: KEY_A } }, guest: { tmdb: { key: KEY_G } }, nope: { tmdb: { key: "x" } }, [B]: { tmdb: { key: 5 } } } });
    expect(v2.doc.profiles).toEqual({ [A]: { tmdb: { key: KEY_A } }, guest: { tmdb: { key: KEY_G } } });
    expect(v2.legacy).toBeNull();
    const v1 = parseCredentials({ tmdb: { key: KEY_A } });
    expect(v1.doc.profiles).toEqual({});
    expect(v1.legacy).toEqual({ tmdb: { key: KEY_A } });
  });
  it("migrates a v1 key into the active owner only", () => {
    const { doc, legacy } = parseCredentials({ tmdb: { key: KEY_A } });
    expect(migrateCredentials(doc, legacy, A)).toBe(true);
    expect(doc.profiles).toEqual({ [A]: { tmdb: { key: KEY_A } } });
    // An owner that already has a key keeps it.
    const d2 = { v: 2 as const, profiles: { [B]: { tmdb: { key: KEY_G } } } };
    migrateCredentials(d2, { tmdb: { key: KEY_A } }, B);
    expect(d2.profiles[B].tmdb.key).toBe(KEY_G);
  });
  it("follows the active owner: a v1 key lands in the first owner, other profiles start empty", async () => {
    disk.credentials = { tmdb: { key: KEY_A } };
    await loadCredentials();
    expect(tmdbKey()).toBeNull(); // owner not known yet: nothing migrated, nothing shown
    setOwner(A);
    await Promise.resolve();
    await Promise.resolve();
    expect(tmdbKey()).toBe(KEY_A);
    expect(disk.credentials).toEqual({ v: 2, profiles: { [A]: { tmdb: { key: KEY_A } } } });
    setOwner(B);
    expect(tmdbKey()).toBeNull();
    await setTmdbKey(KEY_G);
    expect(tmdbKey()).toBe(KEY_G);
    setOwner(A);
    expect(tmdbKey()).toBe(KEY_A);
    setOwner("guest");
    expect(tmdbKey()).toBeNull();
    // Copy option at creation.
    expect(await copyTmdbConnection(A, C)).toBe(true);
    expect(await copyTmdbConnection("guest", C)).toBe(false);
    setOwner(C);
    expect(tmdbKey()).toBe(KEY_A);
    await setTmdbKey(null);
    setOwner(A);
    expect(tmdbKey()).toBe(KEY_A); // clearing C's copy leaves A alone
    emitProfileDeleted(B);
    await new Promise((r) => setTimeout(r, 0));
    expect(Object.keys((disk.credentials as { profiles: object }).profiles)).toEqual([A]);
  });
});

describe("Trakt store", () => {
  beforeEach(() => vi.mocked(tauri.http).mockReset());

  it("parses v2 maps and treats v1 as legacy", () => {
    const v1 = parseTraktStore({ v: 1, clientId: ID, clientSecret: SECRET, tokens: tok("a"), lastSync: 5 });
    expect(v1.legacy).toMatchObject({ clientId: ID, clientSecret: SECRET, lastSync: 5 });
    const v2 = parseTraktStore({ v: 2, profiles: { [A]: { tokens: tok("a"), clientId: ID }, bad: { tokens: tok("b") }, [B]: { tokens: { access_token: "short" } } } });
    expect(Object.keys(v2.doc.profiles)).toEqual([A]);
    const { doc, legacy } = v1;
    expect(migrateTrakt(doc, legacy, B)).toBe(true);
    expect(doc.profiles[B]?.clientSecret).toBe(SECRET);
  });

  it("switches connection with the profile and cancels an in-flight connect", async () => {
    loadTraktStoreForTests({ v: 1, clientId: ID, tokens: tok("a") }, A);
    expect(getTrakt().connected).toBe(true);
    expect((disk.trakt as { v: number }).v).toBe(2);
    setOwner(B);
    expect(getTrakt()).toMatchObject({ connected: false, configured: false, phase: { kind: "idle" } });

    // B starts connecting; the device code request hangs until we switch away.
    let release!: (r: { status: number; body: string }) => void;
    vi.mocked(tauri.http).mockImplementation(async (_url, init) => {
      if (!String(init?.body ?? "").includes("device/code")) return { status: 200, body: JSON.stringify({ configured: true, client_id: ID }) };
      return new Promise((r) => (release = r));
    });
    const run = startTraktConnect();
    await new Promise((r) => setTimeout(r, 0));
    expect(getTrakt().phase.kind).toBe("requesting");
    setOwner(A);
    expect(getTrakt().phase.kind).toBe("idle");
    release({ status: 200, body: JSON.stringify({ device_code: "d".repeat(40), user_code: "ABCD1234", verification_url: "https://trakt.tv/activate", expires_in: 600, interval: 5 }) });
    await run;
    expect(getTrakt()).toMatchObject({ connected: true, phase: { kind: "idle" } }); // A's view is untouched
    cancelTraktConnect();
  });

  it("copies a connection, keeps scrobbling per profile, and doesn't revoke a token another profile still uses", async () => {
    loadTraktStoreForTests({ v: 2, profiles: { [A]: { clientId: ID, clientSecret: SECRET, tokens: tok("a") } } }, A);
    expect(await copyTraktConnection(A, C)).toBe(true);
    expect(await copyTraktConnection(B, C)).toBe(false); // nothing to copy
    expect(hasTraktConnection(C)).toBe(true);
    const profiles = (disk.trakt as { profiles: Record<string, { tokens?: unknown; clientSecret?: string }> }).profiles;
    expect(profiles[C]).toMatchObject({ clientSecret: SECRET, tokens: tok("a") });

    setOwner(B);
    vi.mocked(tauri.http).mockResolvedValue({ status: 201, body: "{}" });
    expect(await traktScrobble("start", { type: "movie", metaId: "tt0111161" }, 1)).toBe(false); // B isn't connected
    expect(tauri.http).not.toHaveBeenCalled();

    setOwner(C);
    await disconnectTrakt();
    // The shared token is only forgotten for C, not revoked (A still uses it).
    expect(vi.mocked(tauri.http).mock.calls.some(([u]) => String(u).includes("revoke"))).toBe(false);
    setOwner(A);
    expect(getTrakt().connected).toBe(true);
    await disconnectTrakt();
    expect(vi.mocked(tauri.http).mock.calls.some(([u]) => String(u).includes("/oauth/revoke"))).toBe(true);
  });
});
