/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { parseProfiles } from "../src/lib/sync";
import { AVATAR_ART, AVATAR_CATEGORIES, AvatarImage, DEFAULT_AVATAR, LEGACY_AVATARS, avatarArt, avatarCategory } from "../src/views/avatars";

const DIR = new URL("../src/assets/avatars/", import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith(".svg"));

describe("built-in avatars", () => {
  it("parses profiles with built-in keys and https image links only", () => {
    const id = "6f1c2b9e-3d4a-4b5c-8d7e-0123456789ab";
    expect(parseProfiles([{ id, name: "Ana", avatar: "https://example.com/a.png" }])?.[0].avatar).toBe("https://example.com/a.png");
    expect(parseProfiles([{ id, name: "Ana", avatar: "http://example.com/a.png" }])).toEqual([]);
    expect(parseProfiles([{ id, name: "Ana", avatar: "adventurer-0" }])?.[0].avatar).toBe("adventurer-0");
  });

  it("has one distinct, server-valid key per bundled file", () => {
    const keys = AVATAR_ART.map((a) => a.key);
    expect(keys.length).toBe(files.length);
    expect(keys.length).toBeGreaterThanOrEqual(30);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9-]{1,24}$/);
    expect(new Set(AVATAR_ART.map((a) => a.label)).size).toBe(keys.length);
  });

  it("maps every earlier avatar key to a current one", () => {
    const keys = new Set(AVATAR_ART.map((a) => a.key));
    for (const old of ["sunny", "fox", "sparkle", "ocean", "moon"]) {
      expect(keys.has(LEGACY_AVATARS[old])).toBe(true);
      expect(avatarArt(old).key).toBe(LEGACY_AVATARS[old]);
    }
    for (const k of keys) expect(LEGACY_AVATARS[k]).toBeUndefined();
    expect(avatarArt("adventurer-5").key).toBe("adventurer-5");
    expect(avatarArt("nope").key).toBe(DEFAULT_AVATAR);
  });

  it("groups every avatar into a picker category, none empty", () => {
    const ids = AVATAR_CATEGORIES.map((c) => c.id);
    for (const a of AVATAR_ART) expect(ids).toContain(avatarCategory(a));
    for (const id of ids) expect(AVATAR_ART.filter((a) => avatarCategory(a) === id).length).toBeGreaterThanOrEqual(10);
  });

  it("bundles self-contained, small SVGs that carry their licence", () => {
    for (const f of files) {
      const svg = readFileSync(new URL(f, DIR), "utf8");
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.length).toBeLessThan(40_000);
      // No external references: avatars must show offline.
      expect(svg).not.toMatch(/(href|src)="(https?:)?\/\//);
      expect(svg).not.toMatch(/<script|on[a-z]+=/i);
      expect(svg).toMatch(f.startsWith("adventurer") ? /creativecommons\.org\/licenses\/by\/4\.0/ : /creativecommons\.org\/publicdomain\/zero\/1\.0/);
      expect(svg).toContain("Lisa Wischofsky");
    }
  });

  it("renders as an image with a label", () => {
    const html = renderToStaticMarkup(createElement(AvatarImage, { avatarKey: "lorelei-0" }));
    expect(html).toContain("<img ");
    expect(html).toContain(`alt="${avatarArt("lorelei-0").label}"`);
  });
});
