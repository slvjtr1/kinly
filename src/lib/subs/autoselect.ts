// Auto Select: deterministic scoring of subtitle candidates for the current video.
//
// Hard rules (candidate rejected): language not wanted, wrong episode, wrong title year.
// Soft signals: language preference order (dominant), source reliability, release-name
// match, forced/SDH status, remembered per-series choice, addon ranking.

import { normalizeLang } from "../lang";
import { parseRelease, releaseSimilarity, type ReleaseInfo } from "../release";

export type SubSource = "embedded" | "sidecar" | "addon";

export type SubCandidate = {
  id: string;
  source: SubSource;
  lang: string | null;
  label: string;
  /** File or release name, when the source provides one. */
  name?: string;
  forced: boolean;
  sdh: boolean;
  isDefault?: boolean;
  /** mpv codec name for embedded tracks. */
  codec?: string;
  sid?: number;
  url?: string;
  path?: string;
  /** Position in the addon's result list (0 = first). */
  addonRank?: number;
  /** Set when the file's text turned out to be in another language than its label. */
  mislabeledAs?: string | null;
};

export type SelectContext = {
  /** Ordered preferred languages, e.g. ["ara", "eng"]. */
  languages: string[];
  avoidSdh: boolean;
  video: ReleaseInfo | null;
  expected: { season: number; episode: number } | null;
  /** Language the user picked manually last time for this series/movie. */
  remembered: string | null;
  audioLang: string | null;
};

export type Ranked = { candidate: SubCandidate; score: number; reasons: string[]; evidence: boolean };

const IMAGE_CODECS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "pgs", "vobsub"]);
const SOURCE_ORDER: Record<SubSource, number> = { embedded: 0, sidecar: 1, addon: 2 };

// Weights. LANG_STEP exceeds the largest sum of soft bonuses (150 + 100 + 60), so a
// less-preferred language only wins when the preferred one is unavailable or rejected.
const LANG_STEP = 400;
const RELEASE_MAX = 150;
const EPISODE_MATCH = 100;
// Forced tracks only cover foreign-language lines: below every full track.
const FORCED_PENALTY = 10_000;

export function isImageCodec(codec?: string): boolean {
  return !!codec && IMAGE_CODECS.has(codec.toLowerCase());
}

/** A language the user chose manually for this title moves to the front. */
export function effectiveLanguages(ctx: SelectContext): string[] {
  const r = ctx.remembered;
  return r ? [r, ...ctx.languages.filter((l) => l !== r)] : ctx.languages;
}

export function scoreCandidate(c: SubCandidate, ctx: SelectContext): Ranked | null {
  const reasons: string[] = [];
  let evidence = false;
  const languages = effectiveLanguages(ctx);
  const rank = c.lang ? languages.indexOf(c.lang) : -1;
  if (languages.length > 0 && rank < 0) return null;
  let score = (languages.length - Math.max(rank, 0)) * LANG_STEP;
  reasons.push(`language #${rank + 1}`);

  const info = c.name ? parseRelease(c.name) : null;
  if (info && ctx.expected && info.season != null && info.episode != null) {
    if (info.season !== ctx.expected.season || info.episode !== ctx.expected.episode) return null;
    score += EPISODE_MATCH;
    evidence = true;
    reasons.push("episode matches");
  }
  if (info && ctx.video?.year && info.year && Math.abs(info.year - ctx.video.year) > 1 && !ctx.expected) {
    return null;
  }
  if (info && ctx.video) {
    const sim = releaseSimilarity(info, ctx.video);
    if (sim != null && sim > 0) {
      score += Math.round(sim * RELEASE_MAX);
      evidence = true;
      reasons.push(`release match ${(sim * 100).toFixed(0)}%`);
    }
  }

  if (c.source === "embedded") {
    score += 60;
    evidence = true;
    reasons.push("embedded in file");
  } else if (c.source === "sidecar") {
    score += 50;
    evidence = true;
    reasons.push("next to the video file");
  } else if (c.addonRank != null) {
    score -= Math.min(c.addonRank, 25) * 2;
  }
  if (isImageCodec(c.codec)) {
    score -= 90;
    reasons.push("image-based (style settings do not apply)");
  }
  if (c.forced) {
    score -= FORCED_PENALTY;
    reasons.push("forced");
  }
  if (c.name && /\bcd ?[1-9]\b/i.test(c.name.replace(/[._]/g, " "))) {
    // One part of a multi-file subtitle: covers only part of the film.
    score -= FORCED_PENALTY;
    reasons.push("partial (CD part)");
  }
  if (c.sdh && ctx.avoidSdh) {
    score -= 70;
    reasons.push("SDH");
  }
  if (c.isDefault) score += 5;
  return { candidate: c, score, reasons, evidence };
}

export function rankCandidates(cands: SubCandidate[], ctx: SelectContext): Ranked[] {
  const seen = new Set<string>();
  const unique = cands.filter((c) => {
    const key = c.url ?? c.path ?? c.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique
    .map((c) => scoreCandidate(c, ctx))
    .filter((r): r is Ranked => r !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        SOURCE_ORDER[a.candidate.source] - SOURCE_ORDER[b.candidate.source] ||
        a.candidate.id.localeCompare(b.candidate.id),
    );
}

const SCRIPT_OF_LANG: Record<string, string> = {
  ara: "arabic", per: "arabic", urd: "arabic", heb: "hebrew", gre: "greek", rus: "cyrillic",
  ukr: "cyrillic", bul: "cyrillic", kor: "hangul", tha: "thai", chi: "cjk", jpn: "cjk",
};
const LATIN_LANGS = new Set([
  "eng", "fre", "ger", "spa", "ita", "por", "pob", "tur", "ind", "may", "dut", "pol", "swe", "nor", "dan",
  "fin", "cze", "hun", "rum", "vie",
]);

/**
 * After download: does the text actually match the claimed language?
 * Returns false only on clear contradictions (e.g. Persian text labelled Arabic,
 * Latin text labelled Arabic, Arabic text labelled English).
 */
export function contentMatches(
  claimed: string | null,
  content: { language: string | null; script: string; confidence: number },
  detectedLang: string | null,
): boolean {
  if (!claimed || content.confidence < 0.6) return true;
  const expectedScript = SCRIPT_OF_LANG[claimed] ?? (LATIN_LANGS.has(claimed) ? "latin" : null);
  if (!expectedScript) return true;
  if (content.script !== expectedScript) return false;
  if (expectedScript === "arabic" && detectedLang) return detectedLang === claimed;
  return true;
}

/** The audio-track fields Auto Sync needs (a subset of mpv's track-list entry). */
export type AudioTrackInfo = {
  type: string;
  lang?: string;
  title?: string;
  default?: boolean;
  selected?: boolean;
  "ff-index"?: number;
};

const COMMENTARY_RE = /\b(commentary|audio description|descriptive|described)\b/i;

/**
 * Audio track to analyse for Auto Sync: the one in the subtitle's language
 * (subtitles are usually timed to the original audio), else the file's default
 * track, else the one playing. Commentary and audio-description tracks are skipped.
 * Returns the ffmpeg stream index, or null to let ffmpeg pick.
 */
export function pickSyncAudioTrack(tracks: AudioTrackInfo[], subLang: string | null, playingFfIndex: number | null): number | null {
  const audio = tracks.filter((t) => t.type === "audio" && typeof t["ff-index"] === "number");
  const usable = audio.filter((t) => !COMMENTARY_RE.test(t.title ?? ""));
  const pool = usable.length ? usable : audio;
  if (!pool.length) return playingFfIndex;
  const byPref = (list: AudioTrackInfo[]) =>
    list.find((t) => t["ff-index"] === playingFfIndex) ?? list.find((t) => t.default) ?? list[0];
  const lang = normalizeLang(subLang);
  const matching = lang ? pool.filter((t) => normalizeLang(t.lang) === lang) : [];
  const pick = matching.length ? byPref(matching) : pool.find((t) => t.default) ?? pool.find((t) => t["ff-index"] === playingFfIndex) ?? pool[0];
  return pick["ff-index"] ?? playingFfIndex;
}
