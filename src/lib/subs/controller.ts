// One subtitle session per playback: gathers candidates, runs Auto Select, loads the
// chosen track into mpv, and runs Auto Sync. Manual choices always win for the
// rest of the session.

import { listen } from "@tauri-apps/api/event";
import { getSubtitles, type Addon } from "../addons";
import { langFromDetected, langName, normalizeLang } from "../lang";
import { rememberSubLang, rememberedSubLang } from "../library";
import { parseRelease } from "../release";
import { player, subsFetch, subsFindSidecars, subsLoadLocal, syncSubtitle, uiLog, type PreparedSub, type SyncReport } from "../tauri";
import { contentMatches, isImageCodec, pickSyncAudioTrack, rankCandidates, type Ranked, type SubCandidate } from "./autoselect";

export type MpvTrack = {
  id: number;
  type: "video" | "audio" | "sub";
  lang?: string;
  title?: string;
  codec?: string;
  forced?: boolean;
  default?: boolean;
  external?: boolean;
  "external-filename"?: string;
  selected?: boolean;
  "ff-index"?: number;
  /** Audio tracks: channel count/layout and sample rate from the demuxer. */
  "demux-channel-count"?: number;
  "demux-channels"?: string;
  "demux-samplerate"?: number;
  /** Video tracks: coded size. */
  "demux-w"?: number;
  "demux-h"?: number;
};

export type SubStatus =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "selected"; label: string; detail: string }
  | { kind: "none"; detail: string }
  | { kind: "syncing"; label: string; progress?: string; deep?: boolean }
  /** `segments` > 1: the timing changes during the video and a retimed copy was loaded. */
  | { kind: "synced"; offset: number; ratio: number; segments?: number; detail?: string }
  | { kind: "in-sync" }
  /** `canRetry`: a deeper analysis has not been tried yet. */
  | { kind: "sync-failed"; detail: string; canRetry?: boolean };

/** Progress event of a running Auto Sync (`sync:progress`). */
type SyncProgress = { stage: string; done: number; total: number; message: string };

/** User-facing explanation of a sync report that was not applied. */
export function syncFailureText(report: Pick<SyncReport, "status" | "reason" | "deep">): string {
  const reason = report.reason?.replace(/\s*\(.*?plain voice detection used\)/, "");
  switch (report.status) {
    case "busy":
      return "Another sync is running";
    case "inconsistent":
      return report.deep
        ? `Timing differs across the video and no clean split was found${reason ? `: ${reason}` : ""}. Adjust manually.`
        : "Timing differs across the video (another cut?)";
    default:
      return reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : "Not enough dialogue to verify timing";
  }
}

export type SessionInput = {
  media: string;
  isLocal: boolean;
  type: string;
  metaId: string;
  videoId: string;
  season?: number;
  episode?: number;
  filename?: string;
  videoSize?: number;
  year?: number;
  headers?: Record<string, string>;
};

export type SessionSettings = { autoSelect: boolean; autoSync: boolean; languages: string[]; avoidSdh: boolean };

const SDH_RE = /\b(sdh|cc|hearing[ -]?impaired|closed captions?)\b/i;
const FORCED_RE = /\b(forced|signs?)\b/i;
/** In titles and release names, capital "HI" marks hearing-impaired subtitles; "hi" is also Hindi's language code. */
export const isSdhLabel = (s: string | undefined) => !!s && (SDH_RE.test(s) || /\bHI\b/.test(s));

export function embeddedCandidates(tracks: MpvTrack[]): SubCandidate[] {
  return tracks
    .filter((t) => t.type === "sub" && !t.external)
    .map((t) => ({
      id: `emb:${t.id}`,
      source: "embedded" as const,
      lang: normalizeLang(t.lang) ?? normalizeLang(t.title),
      label: [t.title, langName(normalizeLang(t.lang))].filter(Boolean).join(" · ") || `Track ${t.id}`,
      name: t.title,
      forced: !!t.forced || FORCED_RE.test(t.title ?? ""),
      sdh: isSdhLabel(t.title),
      isDefault: t.default,
      codec: t.codec,
      sid: t.id,
    }));
}

/**
 * A subtitle file next to the video. Tokens are the lower-cased name parts after the video's name:
 * "hi" alone is Hindi (Movie.hi.srt); next to another language it means hearing-impaired (Movie.en.hi.srt).
 */
export function sidecarCandidate(path: string, name: string, tokens: string[]): SubCandidate {
  const langs = tokens.map((t) => normalizeLang(t));
  const other = langs.find((l, i) => l && tokens[i] !== "hi") ?? null;
  const hiMeansSdh = other !== null && tokens.includes("hi");
  const lang = hiMeansSdh ? other : (langs.find(Boolean) ?? null);
  return {
    id: `side:${path}`,
    source: "sidecar",
    lang,
    label: name,
    name,
    forced: tokens.some((t) => FORCED_RE.test(t)),
    sdh: hiMeansSdh || tokens.some((t) => SDH_RE.test(t)),
    path,
  };
}

export class SubtitleSession {
  candidates: SubCandidate[] = [];
  ranked: Ranked[] = [];
  activeId: string | null = null;
  private manual = false;
  private manualDelay = false;
  private disposed = false;
  private prepared = new Map<string, PreparedSub>();
  private sidByCandidate = new Map<string, number>();
  private syncedPaths = new Set<string>();
  /** Sync attempts per candidate: a repeated manual sync runs the deeper analysis. */
  private syncRuns = new Map<string, number>();
  /** mpv track of a retimed copy (piecewise sync), per candidate. */
  private retimedSid = new Map<string, number>();
  private tracks: MpvTrack[] = [];
  /** Timing correction per subtitle: mpv's sub-delay/sub-speed are global. */
  private timing = new Map<string, { delay: number; speed: number }>();

  constructor(
    private input: SessionInput,
    private settings: SessionSettings,
    private addons: Addon[],
    private onStatus: (s: SubStatus) => void,
    private onChange: () => void,
  ) {}

  dispose() {
    this.disposed = true;
  }

  noteManualDelay() {
    this.manualDelay = true;
  }

  private context() {
    const { input, settings } = this;
    return {
      languages: settings.languages,
      avoidSdh: settings.avoidSdh,
      video: input.filename ? { ...parseRelease(input.filename), year: input.year ?? parseRelease(input.filename).year } : null,
      expected: input.season != null && input.episode != null ? { season: input.season, episode: input.episode } : null,
      remembered: rememberedSubLang(input.metaId),
      audioLang: null,
    };
  }

  private rerank() {
    this.ranked = rankCandidates(this.candidates, this.context());
    this.onChange();
  }

  /** Called once the file is loaded and mpv's track list is known. */
  async start(tracks: MpvTrack[], durationSec: number, audioFfIndex: number | null) {
    this.tracks = tracks;
    this.candidates = embeddedCandidates(tracks);
    if (this.input.isLocal) {
      try {
        const side = await subsFindSidecars(this.input.media);
        this.candidates.push(...side.map((s) => sidecarCandidate(s.path, s.name, s.tokens)));
      } catch {
        /* folder unreadable: embedded and addon subtitles still work */
      }
    }
    this.rerank();
    if (!this.settings.autoSelect) {
      void this.loadAddonCandidates();
      return;
    }
    this.onStatus({ kind: "searching" });
    // A full embedded/side track in the first-choice language is as good as it gets: use it now.
    const best = this.ranked[0];
    const firstLang = this.context().remembered ?? this.settings.languages[0];
    if (best && best.candidate.lang === firstLang && !best.candidate.forced && !isImageCodec(best.candidate.codec)) {
      await this.autoApply(durationSec, audioFfIndex);
      void this.loadAddonCandidates();
      return;
    }
    await this.loadAddonCandidates();
    await this.autoApply(durationSec, audioFfIndex);
  }

  private async loadAddonCandidates() {
    const { input } = this;
    if (!input.metaId.startsWith("tt")) return;
    const hints = { filename: input.filename?.split("\n")[0].slice(0, 200), videoSize: input.videoSize };
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000));
    try {
      const results = await Promise.race([getSubtitles(this.addons, input.type, input.videoId, hints), timeout]);
      if (this.disposed) return;
      for (const r of results) {
        r.items.forEach((s, i) => {
          if (!s.url) return;
          const name = s.subtitleFileName ?? s.movieReleaseName;
          this.candidates.push({
            id: `addon:${s.id ?? s.url}`,
            source: "addon",
            lang: normalizeLang(s.lang),
            label: `${langName(normalizeLang(s.lang))}${name ? ` · ${name}` : ""}`,
            name,
            forced: FORCED_RE.test(name ?? ""),
            sdh: isSdhLabel(name),
            url: s.url,
            addonRank: i,
          });
        });
      }
      this.rerank();
    } catch (e) {
      void uiLog("warn", `subtitle addons: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async autoApply(durationSec: number, audioFfIndex: number | null) {
    if (this.manual || this.disposed) return;
    const tries = this.ranked.slice(0, 4);
    for (const r of tries) {
      if (this.manual || this.disposed) return;
      const ok = await this.apply(r.candidate, false);
      if (!ok) continue;
      const detail = r.evidence ? r.reasons.filter((x) => !x.startsWith("language")).join(", ") : "best available match";
      this.onStatus({ kind: "selected", label: langName(r.candidate.lang), detail });
      await this.maybeSync(r.candidate, durationSec, audioFfIndex);
      return;
    }
    const wanted = this.settings.languages.map(langName).join(" or ");
    this.onStatus({ kind: "none", detail: this.ranked.length ? `No usable ${wanted} subtitle` : `No ${wanted} subtitles found` });
  }

  /** Save the outgoing subtitle's timing and restore the incoming one's (default: none). */
  private async switchTiming(nextId: string) {
    if (this.activeId && this.activeId !== nextId) {
      const [delay, speed] = await Promise.all([player.get<number>("sub-delay"), player.get<number>("sub-speed")]).catch(() => [0, 1]);
      this.timing.set(this.activeId, { delay: Number(delay) || 0, speed: Number(speed) || 1 });
    }
    const t = this.timing.get(nextId) ?? { delay: 0, speed: 1 };
    await player.setMany([
      ["sub-delay", t.delay],
      ["sub-speed", t.speed],
    ]);
  }

  /** Load a candidate into mpv. Returns false if it could not be used. */
  private async apply(c: SubCandidate, manual: boolean): Promise<boolean> {
    try {
      if (c.sid != null) {
        await player.set("sid", c.sid);
      } else {
        let sid = this.retimedSid.get(c.id) ?? this.sidByCandidate.get(c.id);
        if (sid == null) {
          const prep = this.prepared.get(c.id) ?? (c.path ? await subsLoadLocal(c.path) : await subsFetch(c.url!));
          this.prepared.set(c.id, prep);
          const detected = langFromDetected(prep.content.language);
          if (!contentMatches(c.lang, prep.content, detected)) {
            void uiLog("info", `subtitle ${c.id}: text is ${prep.content.language ?? prep.content.script}, labelled ${c.lang}`);
            // Show it under its real language from now on; Auto Select drops it if unwanted.
            c.mislabeledAs = c.lang;
            c.lang = detected;
            this.rerank();
            if (!manual) return false;
          }
          if (this.disposed || (!manual && this.manual)) return false;
          sid = (await player.subAdd(prep.path, c.label.slice(0, 120), c.lang ?? "", true)).sid;
          this.sidByCandidate.set(c.id, sid);
        } else {
          await player.set("sid", sid);
        }
      }
      await this.switchTiming(c.id);
      this.activeId = c.id;
      this.onChange();
      return true;
    } catch (e) {
      void uiLog("warn", `subtitle ${c.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async selectManually(c: SubCandidate | null, durationSec: number, audioFfIndex: number | null) {
    this.manual = true;
    if (!c) {
      await player.set("sid", "no");
      this.activeId = null;
      this.onStatus({ kind: "idle" });
      this.onChange();
      return;
    }
    this.onStatus({ kind: "searching" });
    if (await this.apply(c, true)) {
      if (c.lang) rememberSubLang(this.input.metaId, c.lang);
      this.onStatus({ kind: "selected", label: langName(c.lang), detail: "your choice" });
      await this.maybeSync(c, durationSec, audioFfIndex);
    } else {
      this.onStatus({ kind: "none", detail: "That subtitle could not be loaded" });
    }
  }

  /** External subtitle files can drift; embedded tracks are muxed with the video and are left alone. */
  private async maybeSync(c: SubCandidate, durationSec: number, audioFfIndex: number | null) {
    if (!this.settings.autoSync || c.sid != null) return;
    const prep = this.prepared.get(c.id);
    if (!prep || this.syncedPaths.has(prep.path)) return;
    this.syncedPaths.add(prep.path);
    await this.runSync(c, durationSec, audioFfIndex, false);
  }

  /** True when the next manual sync of `c` runs the deeper analysis. */
  nextSyncIsDeep(c: SubCandidate | null): boolean {
    return !!c && (this.syncRuns.get(c.id) ?? 0) > 0;
  }

  async runSync(
    c: SubCandidate | null,
    durationSec: number,
    audioFfIndex: number | null,
    manual: boolean,
    deep = manual && this.nextSyncIsDeep(c),
  ): Promise<SyncReport | null> {
    const prep = c ? this.prepared.get(c.id) : undefined;
    if (!c || !prep) {
      this.onStatus({ kind: "sync-failed", detail: "Sync works on downloaded or external subtitle files" });
      return null;
    }
    const label = langName(c.lang);
    this.syncRuns.set(c.id, (this.syncRuns.get(c.id) ?? 0) + 1);
    this.onStatus({ kind: "syncing", label, deep, progress: deep ? "Deeper analysis: more of the audio, wider search" : undefined });
    this.manualDelay = false;
    const unlisten = await listen<SyncProgress>("sync:progress", (e) => {
      if (this.disposed || this.activeId !== c.id) return;
      this.onStatus({ kind: "syncing", label, deep, progress: e.payload.message });
    }).catch(() => null);
    try {
      const fileSize = await player.get<number>("file-size").catch(() => null);
      const size = typeof fileSize === "number" && fileSize > 0 ? fileSize : this.input.videoSize;
      const report = await syncSubtitle({
        media: this.input.media,
        subtitlePath: prep.path,
        durationSec,
        audioFfIndex: pickSyncAudioTrack(this.tracks, c.lang, audioFfIndex),
        headers: this.input.headers,
        bytesPerSec: size && durationSec > 0 ? size / durationSec : null,
        manual,
        deep,
      });
      if (this.disposed || this.activeId !== c.id) return report;
      if (this.manualDelay) {
        this.onStatus({ kind: "sync-failed", detail: "Kept your manual timing" });
        return report;
      }
      const retry = !report.deep;
      if (report.status === "piecewise" && report.retimedPath && report.segments.length > 1) {
        await this.useRetimed(c, report.retimedPath);
        this.onStatus({
          kind: "synced",
          offset: report.offsetSec,
          ratio: report.ratio,
          segments: report.segments.length,
          detail: report.segments.map((g) => `${g.offset >= 0 ? "+" : ""}${g.offset.toFixed(2)} s`).join(" → "),
        });
      } else if (report.status === "fit") {
        await this.useOriginal(c);
        const needs = Math.abs(report.offsetSec) >= 0.12 || report.ratio !== 1;
        if (needs) {
          await player.setMany([
            ["sub-speed", report.ratio],
            ["sub-delay", report.offsetSec],
          ]);
          this.onStatus({ kind: "synced", offset: report.offsetSec, ratio: report.ratio });
        } else {
          await player.setMany([
            ["sub-speed", 1],
            ["sub-delay", 0],
          ]);
          this.onStatus({ kind: "in-sync" });
        }
      } else {
        this.onStatus({ kind: "sync-failed", detail: syncFailureText(report), canRetry: retry && report.status !== "busy" });
      }
      return report;
    } catch (e) {
      this.onStatus({ kind: "sync-failed", detail: e instanceof Error ? e.message : String(e), canRetry: !deep });
      return null;
    } finally {
      unlisten?.();
    }
  }

  /** Show the retimed copy of `c` (piecewise sync) instead of the original track. */
  private async useRetimed(c: SubCandidate, path: string) {
    const old = this.retimedSid.get(c.id);
    const { sid } = await player.subAdd(path, c.label.slice(0, 120), c.lang ?? "", true);
    this.retimedSid.set(c.id, sid);
    if (old != null) await player.command("sub-remove", old).catch(() => {});
    this.timing.set(c.id, { delay: 0, speed: 1 });
    await player.setMany([
      ["sub-delay", 0],
      ["sub-speed", 1],
    ]);
    this.onChange();
  }

  /** Back to the original track of `c` after an earlier piecewise sync. */
  private async useOriginal(c: SubCandidate) {
    const old = this.retimedSid.get(c.id);
    const base = this.sidByCandidate.get(c.id);
    if (old == null || base == null) return;
    this.retimedSid.delete(c.id);
    await player.set("sid", base);
    await player.command("sub-remove", old).catch(() => {});
    this.onChange();
  }

  /** A subtitle file the user picked: added to the list and selected (a manual choice). */
  async addLocalFile(path: string, durationSec: number, audioFfIndex: number | null): Promise<SubCandidate> {
    const id = `file:${path}`;
    let c = this.candidates.find((x) => x.id === id);
    if (!c) {
      const name = path.split(/[\\/]/).pop() || path;
      const tokens = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
      c = { ...sidecarCandidate(path, name, tokens), id };
      this.candidates.unshift(c);
      this.rerank();
    }
    await this.selectManually(c, durationSec, audioFfIndex);
    return c;
  }

  /** Local paths of the active external subtitle (for handing off to another player). */
  activeSubtitleFiles(): string[] {
    const c = this.activeCandidate();
    const prep = c ? this.prepared.get(c.id) : undefined;
    return prep ? [prep.path] : [];
  }

  activeCandidate(): SubCandidate | null {
    return this.candidates.find((c) => c.id === this.activeId) ?? null;
  }
}
