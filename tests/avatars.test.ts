import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { parseProfiles } from "../src/lib/sync";
import { AVATAR_ART, AVATAR_CATEGORIES, AvatarSvg, LEGACY_AVATARS, avatarArt, avatarCategory } from "../src/views/avatars";

const ORIGINAL_KEYS = ["sunny", "fox", "owl", "robot", "cat", "bear", "alien", "frog", "ghost", "panda", "octo", "monster"];

describe("built-in avatars", () => {
  it("parses profiles with built-in keys and https image links only", () => {
    const id = "6f1c2b9e-3d4a-4b5c-8d7e-0123456789ab";
    expect(parseProfiles([{ id, name: "Ana", avatar: "https://example.com/a.png" }])?.[0].avatar).toBe("https://example.com/a.png");
    expect(parseProfiles([{ id, name: "Ana", avatar: "http://example.com/a.png" }])).toEqual([]);
    expect(parseProfiles([{ id, name: "Ana", avatar: "axolotl" }])?.[0].avatar).toBe("axolotl");
  });

  it("keeps every existing key and adds at least 24 more, all distinct and server-valid", () => {
    const keys = AVATAR_ART.map((a) => a.key);
    for (const k of ORIGINAL_KEYS) expect(keys).toContain(k);
    expect(keys.length).toBeGreaterThanOrEqual(ORIGINAL_KEYS.length + 24);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9-]{1,24}$/);
    // A new key must never shadow a legacy emoji key (those map to another character).
    for (const k of keys) expect(LEGACY_AVATARS[k]).toBeUndefined();
    expect(avatarArt("sunny").key).toBe("sunny");
    expect(avatarArt("moon").key).toBe("ghost");
    expect(avatarArt("nope").key).toBe("sunny");
  });

  it("groups every avatar into a picker category, none empty", () => {
    const ids = AVATAR_CATEGORIES.map((c) => c.id);
    for (const a of AVATAR_ART) expect(ids).toContain(avatarCategory(a));
    for (const id of ids) expect(AVATAR_ART.filter((a) => avatarCategory(a) === id).length).toBeGreaterThanOrEqual(5);
    for (const k of ORIGINAL_KEYS) expect(avatarCategory(avatarArt(k))).toBe("classics");
  });

  it("renders each one as a self-contained SVG with a label", () => {
    const sheet: string[] = [];
    for (const a of AVATAR_ART) {
      const svg = renderToStaticMarkup(createElement(AvatarSvg, { avatarKey: a.key }));
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain(`aria-label="${a.label}"`);
      expect(svg).not.toMatch(/NaN|undefined|<image|href=/);
      sheet.push(`<figure><div>${svg}</div><figcaption>${avatarCategory(a)} / ${a.key}</figcaption></figure>`);
    }
    // KINLY_AVATAR_SHEET=/path/sheet.html writes a contact sheet for eyeballing the art.
    const out = process.env.KINLY_AVATAR_SHEET;
    if (out) {
      writeFileSync(
        out,
        `<!doctype html><meta charset="utf-8"><style>body{background:#111;color:#ccc;font:12px sans-serif;display:flex;flex-wrap:wrap;gap:10px;padding:10px}figure{margin:0;width:120px;text-align:center}figure div{width:120px;height:120px;border-radius:22%;overflow:hidden}</style>${sheet.join("")}`,
      );
    }
  });
});
