// Settings schema, defaults, validation, and the mapping to mpv properties.

export type ThemeId = "kinly" | "dusk" | "ocean" | "crimson" | "oled" | "daylight";
/** Themes removed in Kinly 1.0 and the closest current theme. */
const RENAMED_THEMES: Record<string, ThemeId> = { abyss: "oled", midnight: "dusk", ember: "kinly", forest: "ocean" };

/** swatch: [background, surface, accent] — drawn by the theme picker. Keep in sync with app.css. */
export const THEMES: { id: ThemeId; name: string; swatch: [string, string, string] }[] = [
  { id: "kinly", name: "Kinly", swatch: ["#0b0a0f", "#1b1822", "#ff7a59"] },
  { id: "dusk", name: "Dusk", swatch: ["#0d0a14", "#1e1830", "#b38cff"] },
  { id: "ocean", name: "Ocean", swatch: ["#02060c", "#0c1b2a", "#1fa2e0"] },
  { id: "crimson", name: "Crimson", swatch: ["#0a0505", "#1c0f11", "#e5384a"] },
  { id: "oled", name: "OLED", swatch: ["#000000", "#0e0e0e", "#ececec"] },
  { id: "daylight", name: "Daylight", swatch: ["#f7f4f1", "#ffffff", "#d9480f"] },
];

export const PERFORMANCE_MODES = ["auto", "maximum", "balanced", "performance"] as const;
export type PerformanceMode = (typeof PERFORMANCE_MODES)[number];
export type ResolvedPerformanceMode = "maximum" | "balanced" | "performance";

export function recommendedPerformanceMode(
  caps: { recommendedMaxHeight?: number; cpuThreads?: number; ramMb?: number } | null,
): ResolvedPerformanceMode {
  if (!caps) return "balanced";
  if ((caps.recommendedMaxHeight ?? 0) >= 2160 || ((caps.cpuThreads ?? 0) >= 8 && (caps.ramMb ?? 0) >= 12000 && (caps.recommendedMaxHeight ?? 0) >= 1440)) {
    return "maximum";
  }
  if ((caps.cpuThreads ?? 4) <= 2 || (caps.ramMb ?? 8000) < 4000 || (caps.recommendedMaxHeight ?? 1080) < 1080) {
    return "performance";
  }
  return "balanced";
}

export function resolvePerformanceMode(
  mode: PerformanceMode | undefined,
  caps: { recommendedMaxHeight?: number; cpuThreads?: number; ramMb?: number } | null,
): ResolvedPerformanceMode {
  return !mode || mode === "auto" ? recommendedPerformanceMode(caps) : mode;
}

export const SUBTITLE_FONTS = [
  { family: "Noto Naskh Arabic", label: "Noto Naskh Arabic (classic)" },
  { family: "Noto Sans Arabic", label: "Noto Sans Arabic (modern)" },
  { family: "Noto Kufi Arabic", label: "Noto Kufi Arabic (geometric)" },
  { family: "Noto Sans", label: "Noto Sans (Latin, Cyrillic, Greek)" },
] as const;

export type SubStyle = {
  font: string;
  bold: boolean;
  size: number; // mpv sub-font-size at 720p reference
  color: string; // #RRGGBB
  opacity: number; // 0..1
  /** Off draws no outline; `outline` keeps the width for when it is turned back on. */
  outlineOn: boolean;
  outline: number; // px
  outlineColor: string;
  shadow: number; // offset px
  shadowColor: string;
  shadowOpacity: number;
  background: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  position: number; // sub-pos, 100 = bottom
  overrideAss: boolean;
};

/** "auto" follows the device (SystemCaps.recommendedMaxHeight); a number is a hard cap in lines. */
export type QualityLimit = "auto" | 2160 | 1440 | 1080 | 720;
export const QUALITY_LIMITS: QualityLimit[] = ["auto", 2160, 1440, 1080, 720];

/** What happens when the end credits start (IntroDB) in an episode with a next one. */
export type CreditsAction = "button" | "auto" | "off";

export const SETTINGS_VERSION = 3;

export type Settings = {
  version: typeof SETTINGS_VERSION;
  appearance: {
    theme: ThemeId;
    uiScale: number;
    reduceMotion: boolean;
    performanceMode: PerformanceMode;
    /** Remote-friendly display: larger focus rings and targets, for a TV across the room. */
    tvMode: boolean;
  };
  subtitles: { autoSelect: boolean; autoSync: boolean; languages: string[]; avoidSdh: boolean; style: SubStyle };
  playback: {
    volume: number;
    resume: boolean;
    hwdec: boolean;
    seekStep: number;
    audioLanguages: string[];
    autoplayNext: boolean;
    /** Skip intros and recaps without asking (IntroDB). Off shows a Skip button instead. */
    skipIntro: boolean;
    credits: CreditsAction;
    qualityLimit: QualityLimit;
    /** "builtin" or an external player id from external_players() (e.g. "mpv", "flatpak:org.videolan.VLC"). */
    player: string;
    /** NVIDIA RTX Video Super Resolution (Windows, RTX GPU, hardware decoding). */
    rtxSuperResolution: boolean;
  };
  /**
   * downloadExternally: hand download links to the browser / a download manager instead of saving
   * them in Kinly. downloadDir: where Kinly saves downloads; null is the Videos folder.
   */
  library: { watchedThreshold: number; folders: string[]; downloadExternally: boolean; downloadDir: string | null };
};

export const DEFAULT_STYLE: SubStyle = {
  font: "Noto Naskh Arabic",
  bold: true,
  size: 50,
  color: "#ffffff",
  opacity: 1,
  outlineOn: true,
  outline: 2.5,
  outlineColor: "#000000",
  shadow: 1.5,
  shadowColor: "#000000",
  shadowOpacity: 0.75,
  background: false,
  backgroundColor: "#000000",
  backgroundOpacity: 0.6,
  position: 100,
  overrideAss: false,
};

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  appearance: { theme: "kinly", uiScale: 1, reduceMotion: false, performanceMode: "auto", tvMode: false },
  subtitles: { autoSelect: true, autoSync: true, languages: ["ara", "eng"], avoidSdh: true, style: DEFAULT_STYLE },
  playback: {
    volume: 100,
    resume: true,
    hwdec: true,
    seekStep: 10,
    audioLanguages: [],
    autoplayNext: true,
    skipIntro: false,
    credits: "button",
    qualityLimit: "auto",
    player: "builtin",
    rtxSuperResolution: false,
  },
  library: { watchedThreshold: 0.9, folders: [], downloadExternally: false, downloadDir: null },
};

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && v >= lo && v <= hi ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const oneOf = <T,>(v: unknown, options: readonly T[], d: T): T => (options.includes(v as T) ? (v as T) : d);
const langs = (v: unknown, d: string[]) =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && /^[a-z]{3}$/.test(x)) ? [...new Set(v as string[])] : d;

/**
 * Older files are upgraded before validation. v1 → v2 only added fields
 * (skipIntro, credits, qualityLimit), which take their defaults below; the
 * step is kept explicit so future renames have a place to go.
 */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const v = typeof raw.version === "number" ? raw.version : 1;
  if (v < 2) raw = { ...raw, version: 2 };
  // v2 → v3 added playback.player (default "builtin").
  if (v < 3) raw = { ...raw, version: 3 };
  return raw;
}

/** Merge stored settings onto defaults; invalid values fall back individually. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = migrate((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>) as Partial<Record<keyof Settings, Record<string, unknown>>>;
  const D = DEFAULT_SETTINGS;
  const a = r.appearance ?? {};
  const s = r.subtitles ?? {};
  const st = (s.style ?? {}) as Record<string, unknown>;
  const p = r.playback ?? {};
  const l = r.library ?? {};
  const DS = DEFAULT_STYLE;
  return {
    version: SETTINGS_VERSION,
    appearance: {
      theme: THEMES.some((t) => t.id === a.theme) ? (a.theme as ThemeId) : (RENAMED_THEMES[String(a.theme)] ?? D.appearance.theme),
      uiScale: num(a.uiScale, 0.8, 1.5, 1),
      reduceMotion: bool(a.reduceMotion, false),
      performanceMode: oneOf(a.performanceMode, PERFORMANCE_MODES, "auto"),
      tvMode: bool(a.tvMode, false),
    },
    subtitles: {
      autoSelect: bool(s.autoSelect, true),
      autoSync: bool(s.autoSync, true),
      languages: langs(s.languages, D.subtitles.languages),
      avoidSdh: bool(s.avoidSdh, true),
      style: {
        font: SUBTITLE_FONTS.some((f) => f.family === st.font) ? (st.font as string) : DS.font,
        bold: bool(st.bold, DS.bold),
        size: num(st.size, 20, 120, DS.size),
        color: isHex(st.color) ? st.color : DS.color,
        opacity: num(st.opacity, 0.2, 1, DS.opacity),
        outlineOn: bool(st.outlineOn, DS.outlineOn),
        outline: num(st.outline, 0, 8, DS.outline),
        outlineColor: isHex(st.outlineColor) ? st.outlineColor : DS.outlineColor,
        shadow: num(st.shadow, 0, 8, DS.shadow),
        shadowColor: isHex(st.shadowColor) ? st.shadowColor : DS.shadowColor,
        shadowOpacity: num(st.shadowOpacity, 0, 1, DS.shadowOpacity),
        background: bool(st.background, DS.background),
        backgroundColor: isHex(st.backgroundColor) ? st.backgroundColor : DS.backgroundColor,
        backgroundOpacity: num(st.backgroundOpacity, 0.1, 1, DS.backgroundOpacity),
        position: num(st.position, 50, 100, DS.position),
        overrideAss: bool(st.overrideAss, DS.overrideAss),
      },
    },
    playback: {
      volume: num(p.volume, 0, 130, 100),
      resume: bool(p.resume, true),
      hwdec: bool(p.hwdec, true),
      seekStep: num(p.seekStep, 3, 60, 10),
      audioLanguages: langs(p.audioLanguages, []),
      autoplayNext: bool(p.autoplayNext, true),
      skipIntro: bool(p.skipIntro, false),
      credits: oneOf(p.credits, ["button", "auto", "off"] as const, "button"),
      qualityLimit: oneOf(p.qualityLimit, QUALITY_LIMITS, "auto"),
      player: typeof p.player === "string" && /^(builtin|[a-z0-9]+|flatpak:[A-Za-z0-9._-]{3,120})$/.test(p.player) ? p.player : "builtin",
      rtxSuperResolution: bool(p.rtxSuperResolution, false),
    },
    library: {
      watchedThreshold: num(l.watchedThreshold, 0.7, 0.98, 0.9),
      folders: Array.isArray(l.folders) ? (l.folders as unknown[]).filter((f): f is string => typeof f === "string").slice(0, 20) : [],
      downloadExternally: bool(l.downloadExternally, false),
      downloadDir: typeof l.downloadDir === "string" && l.downloadDir.trim() && l.downloadDir.length <= 1024 ? l.downloadDir : null,
    },
  };
}

/** "#RRGGBB" + opacity -> mpv "#AARRGGBB". */
export function mpvColor(hex: string, opacity: number): string {
  const a = Math.round(Math.min(1, Math.max(0, opacity)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${a}${hex.slice(1)}`.toUpperCase();
}

/**
 * mpv properties for a subtitle style. The background box replaces the outline
 * (libass box mode). `position` is applied by the player (it also lifts
 * subtitles above the controls), so it is not part of this list.
 */
export function styleToMpv(s: SubStyle): [string, string | number | boolean][] {
  return [
    ["sub-font", s.font],
    ["sub-bold", s.bold],
    ["sub-font-size", s.size],
    ["sub-color", mpvColor(s.color, s.opacity)],
    ["sub-border-size", s.background || !s.outlineOn ? 0 : s.outline],
    ["sub-border-color", mpvColor(s.outlineColor, 1)],
    ["sub-shadow-offset", s.background ? 0 : s.shadow],
    ["sub-shadow-color", mpvColor(s.shadowColor, s.shadowOpacity)],
    ["sub-back-color", s.background ? mpvColor(s.backgroundColor, s.backgroundOpacity) : "#00000000"],
    ["sub-ass-override", s.overrideAss ? "force" : "scale"],
  ];
}

export function playbackToMpv(p: Settings["playback"]): [string, string | number | boolean][] {
  return [
    ["hwdec", p.hwdec ? "auto-safe" : "no"],
    ["alang", p.audioLanguages.join(",")],
  ];
}

/** An NVIDIA RTX GPU by name ("NVIDIA GeForce RTX 4070", "NVIDIA RTX A2000"); mirrors caps::is_rtx. */
export function isRtxGpu(g: { vendor: string; name: string }): boolean {
  return g.vendor === "nvidia" && g.name.split(/[^A-Za-z0-9]+/).some((w) => w.toUpperCase() === "RTX");
}

/**
 * How Settings shows the RTX Video Super Resolution switch: hidden without an
 * RTX GPU, disabled outside Windows (NVIDIA's Linux driver has no VSR).
 */
export type RtxSuperResolutionSupport = "hidden" | "unavailable" | "available";
export function rtxSuperResolutionSupport(
  caps: { gpus: { vendor: string; name: string }[] } | null,
  isWindows: boolean,
): RtxSuperResolutionSupport {
  if (!caps?.gpus.some(isRtxGpu)) return "hidden";
  return isWindows ? "available" : "unavailable";
}

/** True inside WebView2 on Windows. */
export const isWindowsHost = (): boolean => typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
