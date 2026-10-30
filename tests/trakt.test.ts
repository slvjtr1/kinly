import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/tauri", () => ({
  http: vi.fn(),
  storeLoad: vi.fn(async () => ({ value: null, recoveredFrom: null })),
  storeSave: vi.fn(async () => {}),
  uiLog: vi.fn(async () => {}),
}));

import * as tauri from "../src/lib/tauri";
import {
  TRAKT_API, TRAKT_RELAY, mapWatchedMovies, mapWatchedShows, mapWatchlist, oauthPost, parseDeviceCode, parseTraktTokens, pollDeviceToken, scrobbleBody,
} from "../src/lib/trakt";

const tokens = { access_token: "a".repeat(64), refresh_token: "b".repeat(64), expires_in: 86400, created_at: 1_700_000_000, token_type: "bearer", scope: "public" };

function harness(statuses: (number | Error)[]) {
  let t = 0;
  const sleeps: number[] = [];
  const http = vi.mocked(tauri.http);
  http.mockReset();
  for (const s of statuses) {
    if (s instanceof Error) http.mockRejectedValueOnce(s);
    else http.mockResolvedValueOnce({ status: s, body: s === 200 ? JSON.stringify(tokens) : "" });
  }
  const deps = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => 1_700_000_000_000 + t,
    cancelled: () => false,
  };
  return { deps, sleeps, http };
}
const params = { deviceCode: "d".repeat(40), clientId: "c".repeat(64), clientSecret: "s".repeat(64), intervalSec: 5, expiresInSec: 600 };

describe("Trakt device-code polling", () => {
  beforeEach(() => vi.mocked(tauri.http).mockReset());

  it("keeps polling while pending (400) and returns the tokens", async () => {
    const h = harness([400, 400, 200]);
    const r = await pollDeviceToken(params, h.deps);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.tokens).toEqual({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: (1_700_000_000 + 86400) * 1000 });
    expect(h.sleeps).toEqual([5000, 5000, 5000]);
    const [url, init] = h.http.mock.calls[0];
    expect(url).toBe("https://api.trakt.tv/oauth/device/token");
    expect(JSON.parse(init!.body!)).toEqual({ code: params.deviceCode, client_id: params.clientId, client_secret: params.clientSecret });
  });

  it("slows down on 429", async () => {
    const h = harness([429, 429, 400, 200]);
    expect((await pollDeviceToken(params, h.deps)).kind).toBe("ok");
    expect(h.sleeps).toEqual([5000, 10000, 15000, 15000]);
  });

  it.each([
    [404, "invalid"],
    [409, "used"],
    [410, "expired"],
    [418, "denied"],
  ])("stops on %i (%s)", async (status, kind) => {
    const h = harness([400, status]);
    expect((await pollDeviceToken(params, h.deps)).kind).toBe(kind);
    expect(h.http).toHaveBeenCalledTimes(2);
  });

  it("gives up when the code expires locally", async () => {
    const h = harness(Array(200).fill(400));
    const r = await pollDeviceToken({ ...params, expiresInSec: 20 }, h.deps);
    expect(r.kind).toBe("expired");
    expect(h.http.mock.calls.length).toBe(3); // polls at 5, 10, 15 s; at 20 s the code is gone
  });

  it("retries transient errors and stops after repeated network failures", async () => {
    const h = harness([new Error("net"), 503, 200]);
    expect((await pollDeviceToken(params, h.deps)).kind).toBe("ok");
    const h2 = harness(Array(5).fill(new Error("net")));
    expect((await pollDeviceToken(params, h2.deps)).kind).toBe("error");
  });

  it("can be cancelled", async () => {
    const h = harness([400, 400]);
    let n = 0;
    const r = await pollDeviceToken(params, { ...h.deps, cancelled: () => ++n > 1 });
    expect(r.kind).toBe("cancelled");
  });

  it("rejects malformed token responses", async () => {
    const h = harness([]);
    h.http.mockResolvedValueOnce({ status: 200, body: JSON.stringify({ access_token: "x y" }) });
    expect((await pollDeviceToken(params, h.deps)).kind).toBe("error");
  });
});

describe("Trakt response validation", () => {
  it("validates device codes", () => {
    const ok = { device_code: "d".repeat(40), user_code: "5055CC52", verification_url: "https://trakt.tv/activate", expires_in: 600, interval: 5 };
    expect(parseDeviceCode(ok)).toEqual(ok);
    expect(parseDeviceCode({ ...ok, verification_url: "https://evil.example/activate" })?.verification_url).toBe("https://trakt.tv/activate");
    expect(parseDeviceCode({ ...ok, interval: 0 })).toBeNull();
    expect(parseDeviceCode({ ...ok, user_code: "<script>" })).toBeNull();
  });
  it("validates tokens", () => {
    expect(parseTraktTokens(tokens)).not.toBeNull();
    expect(parseTraktTokens({ ...tokens, expires_in: -1 })).toBeNull();
    expect(parseTraktTokens({ ...tokens, refresh_token: 3 })).toBeNull();
  });
});

describe("Trakt → library mapping", () => {
  it("maps watchlist entries by IMDb id and skips the rest", () => {
    const rows = [
      { listed_at: "2024-05-01T10:00:00.000Z", type: "movie", movie: { title: "Dune", year: 2021, ids: { trakt: 1, imdb: "tt1160419" } } },
      { listed_at: "2024-05-01T10:00:00.000Z", type: "movie", movie: { title: "No IMDb", ids: { trakt: 2 } } },
      { listed_at: "x", type: "movie", movie: { title: "Bad id", ids: { imdb: "javascript:alert(1)" } } },
    ];
    expect(mapWatchlist(rows, "movie")).toEqual([{ id: "tt1160419", type: "movie", name: "Dune", addedAt: Date.parse("2024-05-01T10:00:00.000Z") }]);
    expect(mapWatchlist([{ listed_at: "2024-01-01T00:00:00Z", show: { title: "Severance", ids: { imdb: "tt11280740" } } }], "show")[0]).toMatchObject({ id: "tt11280740", type: "series" });
    expect(mapWatchlist("nope", "movie")).toEqual([]);
  });
  it("maps watched movies and episodes to watched progress keyed like the player", () => {
    const m = mapWatchedMovies([{ plays: 1, last_watched_at: "2024-02-02T00:00:00.000Z", movie: { title: "Dune", ids: { imdb: "tt1160419" } } }]);
    expect(m[0]).toMatchObject({ key: "movie:tt1160419", metaId: "tt1160419", videoId: "tt1160419", watched: true });
    const s = mapWatchedShows([
      {
        last_watched_at: "2024-03-03T00:00:00.000Z",
        show: { title: "Severance", ids: { imdb: "tt11280740" } },
        seasons: [{ number: 1, episodes: [{ number: 1, last_watched_at: "2024-03-01T00:00:00.000Z" }, { number: 2 }, { number: "x" }] }],
      },
    ]);
    expect(s.map((p) => p.key)).toEqual(["series:tt11280740:1:1", "series:tt11280740:1:2"]);
    expect(s[0]).toMatchObject({ season: 1, episode: 1, metaId: "tt11280740", updatedAt: Date.parse("2024-03-01T00:00:00.000Z") });
    expect(s[1].updatedAt).toBe(Date.parse("2024-03-03T00:00:00.000Z"));
  });
  it("builds scrobble bodies", () => {
    expect(scrobbleBody({ type: "movie", metaId: "tt1160419" }, 42.123)).toEqual({ movie: { ids: { imdb: "tt1160419" } }, progress: 42.12 });
    expect(scrobbleBody({ type: "series", metaId: "tt11280740", season: 1, episode: 2 }, 120)).toEqual({
      show: { ids: { imdb: "tt11280740" } },
      episode: { season: 1, number: 2 },
      progress: 100,
    });
    expect(scrobbleBody({ type: "local", metaId: "/home/x.mkv" }, 10)).toBeNull();
    expect(scrobbleBody({ type: "series", metaId: "tt11280740" }, 10)).toBeNull();
  });
});

describe("Trakt OAuth transport", () => {
  beforeEach(() => vi.mocked(tauri.http).mockReset().mockResolvedValue({ status: 200, body: "{}" }));
  it("uses Kinly's relay without a secret and never sends one", async () => {
    await oauthPost("/oauth/device/token", { code: "abc" }, { clientId: "x".repeat(32) });
    const [url, init] = vi.mocked(tauri.http).mock.calls[0];
    expect(url).toBe(TRAKT_RELAY);
    expect(JSON.parse(init!.body!)).toEqual({ path: "/oauth/device/token", body: { code: "abc" } });
    expect(init!.headers).toHaveProperty("apikey");
  });
  it("calls Trakt directly with the user's own app", async () => {
    await oauthPost("/oauth/device/token", { code: "abc" }, { clientId: "id", clientSecret: "secret" });
    const [url, init] = vi.mocked(tauri.http).mock.calls[0];
    expect(url).toBe(`${TRAKT_API}/oauth/device/token`);
    expect(JSON.parse(init!.body!)).toEqual({ code: "abc", client_id: "id", client_secret: "secret" });
  });
  it("doesn't send the secret when requesting a device code", async () => {
    await oauthPost("/oauth/device/code", {}, { clientId: "id", clientSecret: "secret" });
    expect(JSON.parse(vi.mocked(tauri.http).mock.calls[0][1]!.body!)).toEqual({ client_id: "id" });
  });
});
