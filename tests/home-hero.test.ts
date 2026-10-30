import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { heroSlides } from "../src/views/Home";
import type { MetaPreview } from "../src/lib/addons";

const m = (id: string, extra: Partial<MetaPreview> = {}): MetaPreview => ({ id, type: "movie", name: id, background: `https://b/${id}`, description: "d", ...extra });

describe("home hero slides", () => {
  it("interleaves the hero catalogs, prefers logos, skips titles without artwork and repeats", () => {
    const movies = [m("a"), m("b", { logo: "https://l/b" }), m("c", { background: undefined }), m("d")];
    const series = [m("s1", { type: "series" }), m("a"), m("s2", { type: "series", logo: "https://l/s2" })];
    expect(heroSlides([movies, series]).map((x) => x.id)).toEqual(["b", "s2", "a", "s1", "d"]);
  });

  it("caps the number of slides and copes with missing catalogs", () => {
    const many = Array.from({ length: 20 }, (_, i) => m(`t${i}`));
    expect(heroSlides([many, undefined])).toHaveLength(6);
    expect(heroSlides([undefined, []])).toEqual([]);
  });
});
