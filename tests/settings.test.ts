/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, THEMES, mpvColor, playbackToMpv, sanitizeSettings, styleToMpv } from "../src/lib/settings";
import { readFileSync } from "node:fs";

describe("settings", () => {
  it("defaults: Kinly theme, Arabic then English, Auto Select and Auto Sync on", () => {
    const s = sanitizeSettings(null);
    expect(s.appearance.theme).toBe("kinly");
    expect(s.appearance.performanceMode).toBe("auto");
    expect(s.subtitles.languages).toEqual(["ara", "eng"]);
    expect(s.subtitles.autoSelect && s.subtitles.autoSync).toBe(true);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("survives a JSON round trip unchanged", () => {
    const s = sanitizeSettings({ ...DEFAULT_SETTINGS, appearance: { theme: "dusk", uiScale: 1.2, reduceMotion: true } });
    expect(sanitizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("replaces only the invalid values of a damaged file", () => {
    const s = sanitizeSettings({
      appearance: { theme: "neon", uiScale: 9, reduceMotion: "yes" },
      subtitles: { languages: ["ara", "xx", 3], autoSync: false, style: { size: 70, color: "red", font: "Comic Sans" } },
      playback: { seekStep: 30, volume: -5 },
      library: { folders: ["/media", 4] },
    });
    expect(s.appearance).toEqual(DEFAULT_SETTINGS.appearance);
    expect(s.subtitles.languages).toEqual(["ara", "eng"]);
    expect(s.subtitles.autoSync).toBe(false);
    expect(s.subtitles.style.size).toBe(70);
    expect(s.subtitles.style.color).toBe("#ffffff");
    expect(s.subtitles.style.font).toBe("Noto Naskh Arabic");
    expect(s.playback.seekStep).toBe(30);
    expect(s.playback.volume).toBe(100);
    expect(s.library.folders).toEqual(["/media"]);
  });

  it("converts colours to mpv #AARRGGBB", () => {
    expect(mpvColor("#ffcc00", 1)).toBe("#FFFFCC00");
    expect(mpvColor("#000000", 0.5)).toBe("#80000000");
    expect(mpvColor("#123456", 0)).toBe("#00123456");
  });

  it("maps a style to mpv properties; the box replaces outline and shadow", () => {
    const plain = Object.fromEntries(styleToMpv(DEFAULT_SETTINGS.subtitles.style));
    expect(plain["sub-font"]).toBe("Noto Naskh Arabic");
    expect(plain["sub-bold"]).toBe(true);
    expect(plain["sub-border-size"]).toBe(2.5);
    expect(plain["sub-back-color"]).toBe("#00000000");
    expect(plain["sub-pos"]).toBeUndefined(); // owned by the player
    const boxed = Object.fromEntries(styleToMpv({ ...DEFAULT_SETTINGS.subtitles.style, background: true }));
    expect(boxed["sub-border-size"]).toBe(0);
    expect(boxed["sub-shadow-offset"]).toBe(0);
    expect(boxed["sub-back-color"]).toBe("#99000000");
  });

  it("maps playback settings", () => {
    const p = Object.fromEntries(playbackToMpv({ ...DEFAULT_SETTINGS.playback, hwdec: false, audioLanguages: ["ara", "eng"] }));
    expect(p).toEqual({ hwdec: "no", alang: "ara,eng" });
  });

  it("defaults the playback additions: no auto-skip, credits button, automatic quality", () => {
    const p = sanitizeSettings(null).playback;
    expect(p.skipIntro).toBe(false);
    expect(p.credits).toBe("button");
    expect(p.qualityLimit).toBe("auto");
  });

  it("validates performanceMode and resolves recommendations", () => {
    expect(sanitizeSettings({ appearance: { performanceMode: "maximum" } }).appearance.performanceMode).toBe("maximum");
    expect(sanitizeSettings({ appearance: { performanceMode: "balanced" } }).appearance.performanceMode).toBe("balanced");
    expect(sanitizeSettings({ appearance: { performanceMode: "performance" } }).appearance.performanceMode).toBe("performance");
    expect(sanitizeSettings({ appearance: { performanceMode: "turbo" } }).appearance.performanceMode).toBe("auto");
  });

  it("migrates a version 1 file: keeps its values and adds the new fields", () => {
    const v1 = { version: 1, appearance: { theme: "ember", uiScale: 1.1, reduceMotion: false }, playback: { seekStep: 15, autoplayNext: false } };
    const s = sanitizeSettings(v1);
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.appearance.theme).toBe("kinly"); // Ember was folded into the Kinly theme
    expect(s.playback).toMatchObject({ seekStep: 15, autoplayNext: false, skipIntro: false, credits: "button", qualityLimit: "auto", player: "builtin" });
  });

  it("migrates a version 2 file to the built-in player and validates player ids", () => {
    expect(sanitizeSettings({ version: 2, playback: { seekStep: 20 } }).playback).toMatchObject({ seekStep: 20, player: "builtin" });
    const pl = (player: unknown) => sanitizeSettings({ playback: { player } }).playback.player;
    expect(pl("mpv")).toBe("mpv");
    expect(pl("flatpak:org.videolan.VLC")).toBe("flatpak:org.videolan.VLC");
    expect(pl("mpv --script=x")).toBe("builtin");
    expect(pl("flatpak:a;b")).toBe("builtin");
    expect(pl(3)).toBe("builtin");
  });

  it("validates the new playback fields", () => {
    const ok = sanitizeSettings({ playback: { skipIntro: true, credits: "auto", qualityLimit: 1080 } }).playback;
    expect(ok).toMatchObject({ skipIntro: true, credits: "auto", qualityLimit: 1080 });
    const bad = sanitizeSettings({ playback: { skipIntro: "yes", credits: "always", qualityLimit: 900 } }).playback;
    expect(bad).toMatchObject({ skipIntro: false, credits: "button", qualityLimit: "auto" });
    expect(sanitizeSettings({ playback: { qualityLimit: "1080" } }).playback.qualityLimit).toBe("auto");
  });

  it("maps removed themes to the closest current one", () => {
    expect(sanitizeSettings({ appearance: { theme: "midnight" } }).appearance.theme).toBe("dusk");
    expect(sanitizeSettings({ appearance: { theme: "abyss" } }).appearance.theme).toBe("oled");
    expect(sanitizeSettings({ appearance: { theme: "forest" } }).appearance.theme).toBe("ocean");
  });

  it("accepts the Crimson and OLED themes, and every theme has CSS tokens", () => {
    expect(sanitizeSettings({ appearance: { theme: "crimson" } }).appearance.theme).toBe("crimson");
    expect(sanitizeSettings({ appearance: { theme: "oled" } }).appearance.theme).toBe("oled");
    const css = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
    for (const t of THEMES) expect(css, t.id).toMatch(new RegExp(`\\[data-theme="${t.id}"\\]\\s*\\{[^}]*--accent:`));
  });
});
