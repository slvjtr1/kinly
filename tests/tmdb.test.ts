import { describe, expect, it } from "vitest";
import { looksLikeTmdbKey, mapResults, tmdbRequest } from "../src/lib/tmdb";

describe("TMDB", () => {
  it("recognises key formats", () => {
    expect(looksLikeTmdbKey("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(looksLikeTmdbKey("eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ4In0.c2lnbmF0dXJl")).toBe(true);
    expect(looksLikeTmdbKey("abc")).toBe(false);
  });
  it("sends v3 keys as a query parameter and v4 tokens as a bearer header", () => {
    const v3 = tmdbRequest("/find/tt1", "0123456789abcdef0123456789abcdef", { external_source: "imdb_id" });
    expect(v3.url).toBe("https://api.themoviedb.org/3/find/tt1?external_source=imdb_id&api_key=0123456789abcdef0123456789abcdef");
    expect(v3.headers.Authorization).toBeUndefined();
    const v4 = tmdbRequest("/configuration", "eyJa.b.c");
    expect(v4.url).toBe("https://api.themoviedb.org/3/configuration");
    expect(v4.headers.Authorization).toBe("Bearer eyJa.b.c");
  });
  it("maps results and drops entries without artwork", () => {
    const r = mapResults(
      [
        { id: 1, title: "A", release_date: "2020-01-02", poster_path: "/a.jpg", vote_average: 7.26, vote_count: 10 },
        { id: 2, name: "B", first_air_date: "", poster_path: null },
      ],
      "movie",
    );
    expect(r).toEqual([{ tmdbId: 1, type: "movie", title: "A", year: "2020", poster: "https://image.tmdb.org/t/p/w342/a.jpg", background: undefined, tmdbRating: 7.3 }]);
  });
});
