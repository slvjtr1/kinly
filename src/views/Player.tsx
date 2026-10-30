import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { traktScrobble } from "../lib/trakt";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft, AudioLines, Captions, CaptionsOff, Check, ChevronsRight, ExternalLink, FileUp, Gauge, Loader2, Maximize, Minimize,
  Pause, Play, RotateCcw, RotateCw, SkipForward, Undo2, Volume1, Volume2, VolumeX, Wand2, X,
} from "lucide-react";
import { getMeta, getStreams } from "../lib/addons";
import { langName } from "../lib/lang";
import { saveProgress } from "../lib/library";
import { DEFAULT_STYLE, playbackToMpv, styleToMpv, SUBTITLE_FONTS, type SubStyle } from "../lib/settings";
import { rankStreams } from "../lib/streams";
import { getCaps, rankCapsFor } from "../lib/caps";
import { activeSegment, normalizeSegments, segmentQuery, skipLabel, type Segment } from "../lib/segments";
import { SubtitleSession, type MpvTrack, type SubStatus } from "../lib/subs/controller";
import { isImageCodec, type SubCandidate } from "../lib/subs/autoselect";
import { cacheImageUrl, introdbSegments, onPlayerEvent, onPlayerProp, player } from "../lib/tauri";
import { openExternally, useExternalPlayers } from "../lib/extplayer";
import { useAddons } from "../lib/useAddons";
import { Switch } from "../components/ui";
import { onShutdown } from "../lib/shutdown";
import { useApp } from "../state";
import { buildPlayRequest, nextEpisode } from "./Detail";
import "../styles/player.css";

export type PlayRequest = {
  url: string;
  title: string;
  metaId: string;
  type: string;
  videoId: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  poster?: string;
  background?: string;
  filename?: string;
  videoSize?: number;
  headers?: Record<string, string>;
  bingeGroup?: string;
  year?: number;
  isLocal?: boolean;
  startSec?: number;
  next?: { videoId: string; season: number; episode: number; title?: string } | null;
};

// time-pos and the cache position change many times a second. They live in a
// small store outside React state so only the seek bar, the clock and the skip
// button re-render, not the whole player (side sheet, track lists).
type Clock = { time: number; cache: number };
function createClock() {
  let v: Clock = { time: 0, cache: 0 };
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(patch: Partial<Clock>) {
      v = { ...v, ...patch };
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
type ClockStore = ReturnType<typeof createClock>;
const useClock = <T,>(clock: ClockStore, pick: (c: Clock) => T) => useSyncExternalStore(clock.subscribe, () => pick(clock.get()));

type PState = {
  duration: number;
  paused: boolean;
  buffering: boolean;
  tracks: MpvTrack[];
  sid: number | null;
  aid: number | null;
  volume: number;
  mute: boolean;
  subDelay: number;
  subSpeed: number;
  speed: number;
  eof: boolean;
  loaded: boolean;
};

const INITIAL: PState = {
  duration: 0, paused: false, buffering: true, tracks: [], sid: null, aid: null,
  volume: 100, mute: false, subDelay: 0, subSpeed: 1, speed: 1, eof: false, loaded: false,
};

/** Volume above 100% amplifies (mpv volume-max). */
const VOLUME_MAX = 150;
const NORM_LABEL = "@kinlynorm";
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

type Tab = "subs" | "audio" | "playback";

export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

const trackId = (v: unknown): number | null => (typeof v === "number" ? v : null);
const signed = (v: number, digits = 2) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function Player({ req }: { req: PlayRequest }) {
  const { settings, update, back, navigate, toast } = useApp();
  const setStyle = (patch: Partial<SubStyle>) =>
    update((st) => ({ ...st, subtitles: { ...st.subtitles, style: { ...st.subtitles.style, ...patch } } }));
  const { addons } = useAddons();
  const [s, setS] = useState<PState>({ ...INITIAL, volume: settings.playback.volume });
  const [error, setError] = useState<string | null>(null);
  const [idle, setIdle] = useState(false);
  const [sheet, setSheet] = useState<Tab | null>(null);
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const [clock] = useState(createClock);
  const [segments, setSegments] = useState<Segment[]>([]);
  const segmentsRef = useRef<Segment[]>([]);
  segmentsRef.current = segments;
  const [osd, setOsd] = useState<string | null>(null);
  const [pulse, setPulse] = useState<{ n: number; play: boolean } | null>(null);
  const [subStatus, setSubStatus] = useState<SubStatus>({ kind: "idle" });
  const [fullscreen, setFullscreen] = useState(false);
  const [audioDelay, setAudioDelay] = useState(0);
  const [normalize, setNormalize] = useState(false);
  // Fullscreen state of the app when the player opened; restored when it closes.
  const wasFullscreen = useRef(false);
  useEffect(() => {
    void getCurrentWindow().isFullscreen().then((f) => {
      wasFullscreen.current = f;
      setFullscreen(f);
    });
  }, []);
  const [, force] = useState(0);
  const session = useRef<SubtitleSession | null>(null);
  const stateRef = useRef(s);
  stateRef.current = s;
  const idleTimer = useRef<number | undefined>(undefined);
  const osdTimer = useRef<number | undefined>(undefined);
  const clickTimer = useRef<number | undefined>(undefined);
  const overControls = useRef(false);
  const lastSaved = useRef(0);
  const started = useRef(false);
  const advancing = useRef(false);

  const flash = useCallback((text: string) => {
    setOsd(text);
    window.clearTimeout(osdTimer.current);
    osdTimer.current = window.setTimeout(() => setOsd(null), 1400);
  }, []);

  const thumbRef = useRef<string | undefined>(req.background);
  const persist = useCallback(() => {
    const { duration } = stateRef.current;
    const { time } = clock.get();
    if (duration > 0 && time > 5) {
      saveProgress(
        {
          key: `${req.type}:${req.videoId}`, metaId: req.metaId, type: req.type, name: req.title, poster: req.poster,
          background: thumbRef.current, videoId: req.videoId, season: req.season, episode: req.episode,
          episodeTitle: req.episodeTitle, source: req.isLocal ? req.url : undefined, position: time, duration,
        },
        settings.library.watchedThreshold,
      );
    }
  }, [req, settings.library.watchedThreshold, clock]);
  // Closing the window mid-playback keeps the position (saved before the library is flushed).
  useEffect(() => onShutdown(persist, "capture"), [persist]);

  // Load media and subscribe to mpv.
  useEffect(() => {
    document.body.classList.add("playing");
    let unlisten: (() => void)[] = [];
    let live = true;
    session.current = new SubtitleSession(
      {
        media: req.url, isLocal: !!req.isLocal, type: req.type, metaId: req.metaId, videoId: req.videoId,
        season: req.season, episode: req.episode, filename: req.filename, videoSize: req.videoSize, year: req.year,
        headers: req.headers,
      },
      settings.subtitles,
      addons,
      setSubStatus,
      () => force((n) => n + 1),
    );
    (async () => {
      unlisten.push(
        await onPlayerProp(({ name, value }) => {
          if (!live) return;
          if (name === "time-pos") return onTime.current(Number(value) || 0);
          if (name === "demuxer-cache-time") return clock.set({ cache: Number(value) || 0 });
          setS((p) => {
            switch (name) {
              case "duration": return { ...p, duration: Number(value) || 0 };
              case "pause": return { ...p, paused: !!value };
              case "paused-for-cache": return { ...p, buffering: !!value };
              case "track-list": return { ...p, tracks: Array.isArray(value) ? (value as MpvTrack[]) : [] };
              case "sid": return { ...p, sid: trackId(value) };
              case "aid": return { ...p, aid: trackId(value) };
              case "volume": return { ...p, volume: Number(value) || 0 };
              case "mute": return { ...p, mute: !!value };
              case "sub-delay": return { ...p, subDelay: Number(value) || 0 };
              case "sub-speed": return { ...p, subSpeed: Number(value) || 1 };
              case "speed": return { ...p, speed: Number(value) || 1 };
              case "eof-reached": return { ...p, eof: !!value };
              default: return p;
            }
          });
        }),
      );
      unlisten.push(
        await onPlayerEvent((e) => {
          if (!live) return;
          if (e.type === "file-loaded") setS((p) => ({ ...p, loaded: true, buffering: false }));
          if (e.type === "playback-restart") setS((p) => ({ ...p, buffering: false }));
          if (e.type === "error") setError(req.isLocal ? "This file could not be played." : "This source could not be played. It may be offline or unsupported.");
        }),
      );
      try {
        await player.load(req.url, { startSec: req.startSec, title: req.title, headers: req.headers });
        await player.setMany([
          ...styleToMpv(settings.subtitles.style),
          ...playbackToMpv(settings.playback),
          ["volume-max", VOLUME_MAX],
          ["volume", settings.playback.volume],
          ["audio-delay", 0],
        ]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
      unlisten.forEach((u) => u());
      session.current?.dispose();
      persist();
      void player.stop();
      // Per-episode tweaks do not leak into the next file.
      void player.command("af", "remove", NORM_LABEL).catch(() => {});
      void player.setMany([["audio-delay", 0], ["speed", 1]]).catch(() => {});
      document.body.classList.remove("playing");
      void getCurrentWindow().setFullscreen(wasFullscreen.current);
    };
    // Settings changes are applied by the effect below, not by reloading media.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.url, req.videoId]);

  // Trakt scrobbling: start/pause follow playback state, stop on end or close.
  const scrobble = useCallback((kind: "start" | "pause" | "stop") => {
    const { duration } = stateRef.current;
    if (duration > 0) void traktScrobble(kind, req, (clock.get().time / duration) * 100);
  }, [req, clock]);
  useEffect(() => {
    if (!s.loaded) return;
    scrobble(s.eof ? "stop" : s.paused ? "pause" : "start");
  }, [s.loaded, s.paused, s.eof, scrobble]);
  useEffect(() => () => scrobble("stop"), [scrobble]);

  // Live-apply style changes made while playing.
  useEffect(() => {
    if (s.loaded) void player.setMany(styleToMpv(settings.subtitles.style));
  }, [settings.subtitles.style, s.loaded]);

  // Lift subtitles above the control bar while it is visible. sub-pos is used
  // because mpv 0.37 ignores live sub-margin-y changes on loaded text tracks.
  const controlsVisible = !(idle && !sheet && !s.paused);
  const userPos = settings.subtitles.style.position;
  useEffect(() => {
    if (s.loaded) void player.set("sub-pos", controlsVisible ? Math.min(userPos, 82) : userPos);
  }, [controlsVisible, s.loaded, userPos]);

  // Start Auto Select once tracks and duration are known.
  useEffect(() => {
    if (started.current || !s.loaded || s.duration <= 0) return;
    started.current = true;
    const audio = s.tracks.find((t) => t.type === "audio" && t.selected);
    void session.current?.start(s.tracks, s.duration, audio?.["ff-index"] ?? null);
  }, [s.loaded, s.duration, s.tracks]);

  // IntroDB segments, once the duration is known. Offline or unknown titles just have none.
  useEffect(() => {
    const q = segmentQuery(req);
    if (!q || !s.loaded || s.duration <= 0) return;
    let live = true;
    introdbSegments({ ...q, durationMs: Math.round(s.duration * 1000) })
      .then((r) => live && setSegments(normalizeSegments(r?.segments, s.duration)))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.metaId, req.videoId, s.loaded, s.duration > 0]);

  const playNext = useCallback(async () => {
    if (!req.next || advancing.current) return;
    advancing.current = true;
    persist();
    try {
      const meta = await getMeta(addons, req.type, req.metaId);
      const nextVideo = meta.videos?.find((v) => v.id === req.next!.videoId) ?? null;
      const caps = rankCapsFor(getCaps(), settings.playback.qualityLimit, settings.playback.hwdec);
      const ranked = rankStreams(await getStreams(addons, req.type, req.next.videoId), caps).filter((r) => r.playable);
      const pick = ranked.find((r) => req.bingeGroup && r.stream.behaviorHints?.bingeGroup === req.bingeGroup) ?? ranked[0];
      if (!pick || !nextVideo) throw new Error("No playable source for the next episode");
      const nextReq = buildPlayRequest(meta, pick, nextVideo, false);
      nextReq.next = nextEpisode(meta, nextVideo.id) ? nextReq.next : null;
      // Replaces this episode, so Back leaves the player instead of replaying earlier episodes.
      navigate({ name: "player", req: nextReq }, { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      advancing.current = false;
    }
  }, [req, addons, navigate, toast, persist, settings.playback.qualityLimit, settings.playback.hwdec]);

  useEffect(() => {
    if (s.eof && s.loaded && req.next && settings.playback.autoplayNext) void playNext();
  }, [s.eof, s.loaded, req.next, settings.playback.autoplayNext, playNext]);

  const seekTo = useCallback((t: number) => void player.command("seek", t.toFixed(2), "absolute"), []);
  const skipSegment = (seg: Segment) => {
    if (seg.kind === "credits" && req.next) return void playNext();
    seekTo(seg.endSec ?? stateRef.current.duration);
  };

  // Called for every time-pos update, outside React rendering: progress saves and auto-skip.
  const autoSkipped = useRef(new Set<number>());
  const onTime = useRef<(t: number) => void>(() => {});
  onTime.current = (t) => {
    clock.set({ time: t });
    if (Math.abs(t - lastSaved.current) > 10) {
      lastSaved.current = t;
      persist();
    }
    const seg = activeSegment(segmentsRef.current, t);
    if (!seg || autoSkipped.current.has(seg.startSec)) return;
    const auto = seg.kind === "credits" ? settings.playback.credits === "auto" && !!req.next : settings.playback.skipIntro;
    if (!auto) return;
    autoSkipped.current.add(seg.startSec);
    flash(seg.kind === "credits" ? "Playing next episode" : `Skipped ${seg.kind}`);
    skipSegment(seg);
  };

  const audioIndex = () => stateRef.current.tracks.find((t) => t.type === "audio" && t.selected)?.["ff-index"] ?? null;

  const seekBy = (d: number) => {
    void player.command("seek", d, "relative");
    flash(`${d > 0 ? "+" : "−"}${Math.abs(d)} s`);
  };
  const togglePause = () => {
    const play = stateRef.current.paused;
    void player.set("pause", !play);
    setPulse((p) => ({ n: (p?.n ?? 0) + 1, play }));
  };
  const setVolume = (v: number, quiet = false) => {
    const vol = clamp(Math.round(v), 0, VOLUME_MAX);
    void player.set("volume", vol);
    if (stateRef.current.mute && vol > 0) void player.set("mute", false);
    if (!quiet) flash(`Volume ${vol}%${vol > 100 ? " · boost" : ""}`);
  };
  const setSubDelay = (v: number, quiet = false) => {
    session.current?.noteManualDelay();
    // Round to 10 ms only to drop float noise; keep Auto Sync's precision.
    const d = Math.round(v * 100) / 100;
    void player.set("sub-delay", d);
    if (!quiet) flash(`Subtitle delay ${signed(d)} s`);
  };
  const changeDelay = (d: number) => setSubDelay(stateRef.current.subDelay + d);
  const setSubSpeed = (v: number) => {
    session.current?.noteManualDelay();
    void player.set("sub-speed", v);
  };
  const resetTiming = () => {
    session.current?.noteManualDelay();
    void player.setMany([["sub-delay", 0], ["sub-speed", 1]]);
    flash("Subtitle timing reset");
  };
  const changeAudioDelay = (v: number) => {
    const d = Math.round(clamp(v, -5, 5) * 100) / 100;
    setAudioDelay(d);
    void player.set("audio-delay", d);
  };
  const toggleNormalize = async (on: boolean) => {
    try {
      if (on) await player.command("af", "add", `${NORM_LABEL}:lavfi=[dynaudnorm=f=250:g=15]`);
      else await player.command("af", "remove", NORM_LABEL);
      setNormalize(on);
    } catch (e) {
      toast(`Normalisation unavailable: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };
  const setSpeed = (v: number) => {
    const sp = Math.round(clamp(v, 0.5, 2) * 100) / 100;
    void player.set("speed", sp);
    flash(`Speed ${sp}×`);
  };
  const toggleFullscreen = async () => {
    const w = getCurrentWindow();
    const next = !(await w.isFullscreen());
    await w.setFullscreen(next);
    setFullscreen(next);
  };
  const exit = async () => {
    // Local files have no artwork: keep the current frame for Continue watching.
    if (req.isLocal && stateRef.current.loaded && clock.get().time > 5) {
      const thumb = await player.thumbnail(req.videoId).catch(() => null);
      if (thumb) thumbRef.current = `${cacheImageUrl(thumb)}?t=${Date.now()}`;
    }
    persist();
    back();
  };
  const toggleSheet = (tab: Tab) => setSheet((cur) => (cur === tab ? null : tab));
  const closeSheet = () => setSheet(null);

  const loadSubFile = async () => {
    const path = await openDialog({
      multiple: false,
      directory: false,
      title: "Load a subtitle file",
      filters: [{ name: "Subtitles", extensions: ["srt", "ass", "ssa", "vtt", "sub", "txt"] }],
    });
    if (typeof path !== "string" || !session.current) return;
    await session.current.addLocalFile(path, stateRef.current.duration, audioIndex());
  };

  const handOff = async (playerId: string) => {
    const at = clock.get().time;
    void player.set("pause", true);
    try {
      const p = await openExternally(req, at, { player: playerId, subtitles: session.current?.activeSubtitleFiles() });
      persist();
      toast(`Opened in ${p.name} at ${fmtTime(at)}. Kinly is paused.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "Escape") {
        e.preventDefault();
        if (sheetRef.current) setSheet(null);
        else if (fullscreen) void toggleFullscreen();
        else void exit();
        wake();
        return;
      }
      // Sliders, selects and colour pickers keep their own keys.
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const step = settings.playback.seekStep;
      let handled = true;
      if (k === " " || k === "k") togglePause();
      else if (k === "ArrowLeft") seekBy(e.shiftKey ? -60 : -step);
      else if (k === "ArrowRight") seekBy(e.shiftKey ? 60 : step);
      else if (k === "ArrowUp") setVolume(stateRef.current.volume + 5);
      else if (k === "ArrowDown") setVolume(stateRef.current.volume - 5);
      else if (k === "m") void player.set("mute", !stateRef.current.mute);
      else if (k === "f" || k === "F11") void toggleFullscreen();
      else if (k === "s" || k === "c") toggleSheet("subs");
      else if (k === "a") toggleSheet("audio");
      else if (k === "z") changeDelay(-0.1);
      else if (k === "x") changeDelay(0.1);
      else if (k === "n" && req.next) void playNext();
      else handled = false;
      if (handled) {
        e.preventDefault();
        wake();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Mouse moves arrive at 60-120 Hz: re-arm the idle timer at most every 200 ms while awake.
  const lastWake = useRef(0);
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const wake = () => {
    const now = performance.now();
    if (!idleRef.current && now - lastWake.current < 200) return;
    lastWake.current = now;
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    const arm = () => {
      idleTimer.current = window.setTimeout(() => (overControls.current ? arm() : setIdle(true)), 3000);
    };
    arm();
  };
  useEffect(() => {
    wake();
    return () => {
      window.clearTimeout(idleTimer.current);
      window.clearTimeout(clickTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A click on the picture closes an open sheet, otherwise plays/pauses. It waits
  // briefly so a double click (fullscreen) does not also pause.
  const onStageClick = () => {
    window.clearTimeout(clickTimer.current);
    if (sheetRef.current) return setSheet(null);
    clickTimer.current = window.setTimeout(togglePause, 220);
  };
  const onStageDouble = () => {
    window.clearTimeout(clickTimer.current);
    if (!sheetRef.current) void toggleFullscreen();
  };
  const hoverControls = { onMouseEnter: () => void (overControls.current = true), onMouseLeave: () => void (overControls.current = false) };

  const audios = useMemo(() => s.tracks.filter((t) => t.type === "audio"), [s.tracks]);
  const sess = session.current;
  const episodeLine = req.season != null ? `S${req.season} · E${req.episode}${req.episodeTitle ? ` · ${req.episodeTitle}` : ""}` : "";
  const busy = !error && (s.buffering || !s.loaded);
  const step = settings.playback.seekStep;

  return (
    <div className={`kp ${controlsVisible ? "" : "kp-idle"} ${sheet ? "kp-has-sheet" : ""}`} onMouseMove={wake}>
      <div className="kp-stage" onClick={onStageClick} onDoubleClick={onStageDouble} aria-hidden />
      <div className="kp-shade" aria-hidden />

      <div className="kp-center">
        {error ? (
          <div className="kp-card" role="alert">
            <b>Playback failed</b>
            <span>{error}</span>
            <button className="kp-btn kp-btn-solid" onClick={() => void exit()}>Choose another source</button>
          </div>
        ) : busy ? (
          <div className="kp-loading" role="status">
            <span className="kp-ring" aria-hidden />
            <span>{s.loaded ? "Buffering…" : "Opening…"}</span>
          </div>
        ) : s.eof && !req.next ? (
          <div className="kp-card">
            <b>Finished</b>
            <button className="kp-btn kp-btn-solid" onClick={() => void exit()}>Back</button>
          </div>
        ) : s.paused && !sheet ? (
          <button className="kp-bigplay" onClick={togglePause} aria-label="Play"><Play fill="currentColor" size={34} /></button>
        ) : null}
        {pulse && !busy && !error && (
          <span key={pulse.n} className="kp-pulse" aria-hidden>{pulse.play ? <Play fill="currentColor" size={30} /> : <Pause fill="currentColor" size={30} />}</span>
        )}
      </div>

      {osd && <div className="kp-osd" role="status">{osd}</div>}
      <SubStatusChip status={subStatus} hidden={!!sheet || (idle && !s.paused && subStatus.kind !== "syncing")} />

      <header className="kp-top" {...hoverControls}>
        <button className="kp-icon" onClick={() => void exit()} aria-label="Back" title="Back (Esc)"><ArrowLeft size={22} /></button>
        <div className="kp-heading">
          <div className="kp-title">{req.title}</div>
          {episodeLine && <div className="kp-episode">{episodeLine}</div>}
        </div>
      </header>

      <SkipButton clock={clock} segments={segments} hasNext={!!req.next} showCredits={settings.playback.credits !== "off"} lifted={controlsVisible} onSkip={skipSegment} />

      <footer className="kp-bottom" {...hoverControls} onDoubleClick={(e) => e.stopPropagation()}>
        <SeekBar clock={clock} duration={s.duration} segments={segments} onSeek={seekTo} />
        <div className="kp-bar">
          <div className="kp-group">
            <button className="kp-icon kp-icon-lg" onClick={togglePause} aria-label={s.paused ? "Play" : "Pause"} title={s.paused ? "Play (Space)" : "Pause (Space)"}>
              {s.paused ? <Play fill="currentColor" size={24} /> : <Pause fill="currentColor" size={24} />}
            </button>
            <button className="kp-icon kp-jump" onClick={() => seekBy(-step)} aria-label={`Back ${step} seconds`} title={`Back ${step} s (←)`}>
              <RotateCcw size={22} /><span>{step}</span>
            </button>
            <button className="kp-icon kp-jump" onClick={() => seekBy(step)} aria-label={`Forward ${step} seconds`} title={`Forward ${step} s (→)`}>
              <RotateCw size={22} /><span>{step}</span>
            </button>
            <div className="kp-volume">
              <button className="kp-icon" onClick={() => void player.set("mute", !s.mute)} aria-label={s.mute ? "Unmute" : "Mute"} title="Mute (M)">
                {s.mute || s.volume === 0 ? <VolumeX size={21} /> : s.volume < 50 ? <Volume1 size={21} /> : <Volume2 size={21} />}
              </button>
              <Range className="kp-volume-range" min={0} max={VOLUME_MAX} step={1} value={s.mute ? 0 : s.volume} onChange={(v) => setVolume(v, true)} label="Volume" mark={100} />
            </div>
            <TimeLabel clock={clock} duration={s.duration} />
          </div>
          <div className="kp-group">
            {req.next && (
              <button className="kp-icon kp-next" onClick={() => void playNext()} aria-label="Next episode" title={`Next episode (N)${req.next.title ? ` · ${req.next.title}` : ""}`}>
                <SkipForward size={21} /><span>Next</span>
              </button>
            )}
            <button className={`kp-icon ${sheet === "subs" ? "on" : ""}`} onClick={() => toggleSheet("subs")} aria-label="Subtitles" aria-pressed={sheet === "subs"} title="Subtitles (S)">
              {s.sid == null ? <CaptionsOff size={21} /> : <Captions size={21} />}
            </button>
            <button className={`kp-icon ${sheet === "audio" ? "on" : ""}`} onClick={() => toggleSheet("audio")} aria-label="Audio" aria-pressed={sheet === "audio"} title="Audio (A)">
              <AudioLines size={21} />
            </button>
            <button className={`kp-icon kp-speed ${sheet === "playback" ? "on" : ""}`} onClick={() => toggleSheet("playback")} aria-label="Playback speed and info" aria-pressed={sheet === "playback"} title="Playback">
              {s.speed === 1 ? <Gauge size={21} /> : <span>{s.speed}×</span>}
            </button>
            <button className="kp-icon" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} title="Fullscreen (F)">
              {fullscreen ? <Minimize size={21} /> : <Maximize size={21} />}
            </button>
          </div>
        </div>
      </footer>

      <aside className={`kp-sheet ${sheet ? "open" : ""}`} inert={!sheet} aria-hidden={!sheet} aria-label="Player settings" onDoubleClick={(e) => e.stopPropagation()} {...hoverControls}>
        <div className="kp-sheet-head">
          <div className="kp-tabs" role="tablist" style={{ "--i": sheet === "audio" ? 1 : sheet === "playback" ? 2 : 0 } as CSSProperties}>
            {([["subs", "Subtitles"], ["audio", "Audio"], ["playback", "Playback"]] as const).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={sheet === id} className={`kp-tab ${sheet === id ? "on" : ""}`} onClick={() => setSheet(id)}>{label}</button>
            ))}
          </div>
          <button className="kp-icon kp-close" onClick={closeSheet} aria-label="Close panel" title="Close (Esc)"><X size={20} /></button>
        </div>
        <div className="kp-sheet-body">
          {sheet === "subs" && sess && (
            <SubtitlesTab
              sess={sess}
              s={s}
              status={subStatus}
              style={settings.subtitles.style}
              setStyle={setStyle}
              onSelect={(c) => void sess.selectManually(c, s.duration, audioIndex())}
              onLoadFile={() => void loadSubFile()}
              onSync={() => void sess.runSync(sess.activeCandidate(), s.duration, audioIndex(), true)}
              setDelay={setSubDelay}
              setSpeed={setSubSpeed}
              resetTiming={resetTiming}
            />
          )}
          {sheet === "audio" && (
            <AudioTab
              tracks={audios}
              aid={s.aid}
              volume={s.mute ? 0 : s.volume}
              setVolume={(v) => setVolume(v, true)}
              delay={audioDelay}
              setDelay={changeAudioDelay}
              normalize={normalize}
              setNormalize={(v) => void toggleNormalize(v)}
            />
          )}
          {sheet === "playback" && (
            <PlaybackTab speed={s.speed} setSpeed={setSpeed} defaultPlayer={settings.playback.player} onHandOff={(id) => void handOff(id)} />
          )}
        </div>
      </aside>
    </div>
  );
}

/* ───────────────────────────── Controls ───────────────────────────── */

function Range({ min, max, step, value, onChange, label, className = "", mark, disabled }: {
  min: number; max: number; step: number; value: number; onChange: (v: number) => void; label: string; className?: string; mark?: number; disabled?: boolean;
}) {
  const pct = ((clamp(value, min, max) - min) / (max - min)) * 100;
  const style = { "--p": `${pct}%`, ...(mark != null ? { "--m": `${((mark - min) / (max - min)) * 100}%` } : {}) } as CSSProperties;
  return (
    <input
      type="range"
      className={`kp-range ${mark != null ? "has-mark" : ""} ${className}`}
      min={min}
      max={max}
      step={step}
      value={clamp(value, min, max)}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={label}
      disabled={disabled}
      style={style}
    />
  );
}

function Stepper({ value, onMinus, onPlus, minusLabel, plusLabel, wide }: { value: ReactNode; onMinus: () => void; onPlus: () => void; minusLabel: string; plusLabel: string; wide?: boolean }) {
  return (
    <div className={`kp-stepper ${wide ? "wide" : ""}`}>
      <button onClick={onMinus} aria-label={minusLabel} title={minusLabel}>−</button>
      <output>{value}</output>
      <button onClick={onPlus} aria-label={plusLabel} title={plusLabel}>+</button>
    </div>
  );
}

function Field({ label, hint, children, disabled }: { label: string; hint?: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={`kp-field ${disabled ? "off" : ""}`}>
      <div className="kp-field-label">
        <span>{label}</span>
        {hint != null && <small>{hint}</small>}
      </div>
      <div className="kp-field-control">{children}</div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="kp-section">
      <div className="kp-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Swatches({ value, options, onChange, label, disabled }: { value: string; options: string[]; onChange: (v: string) => void; label: string; disabled?: boolean }) {
  const custom = !options.includes(value.toLowerCase());
  return (
    <div className="kp-swatches" role="radiogroup" aria-label={label}>
      {options.map((c) => (
        <button key={c} role="radio" aria-checked={value.toLowerCase() === c} aria-label={c} className="kp-swatch" style={{ "--c": c } as CSSProperties} onClick={() => onChange(c)} disabled={disabled} />
      ))}
      <label className={`kp-swatch kp-swatch-custom ${custom ? "on" : ""}`} style={{ "--c": value } as CSSProperties} title="Custom colour">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label}: custom`} disabled={disabled} />
      </label>
    </div>
  );
}

/* ───────────────────────────── Subtitles tab ───────────────────────────── */

/** Common frame-rate conversions for sub-speed (subtitle timestamps × ratio). */
const RATIOS: { v: number; label: string }[] = [
  { v: 1, label: "Original timing" },
  { v: 25 / 23.976, label: "25 → 23.976 fps (×1.0427)" },
  { v: 23.976 / 25, label: "23.976 → 25 fps (×0.9590)" },
  { v: 25 / 24, label: "25 → 24 fps (×1.0417)" },
  { v: 24 / 25, label: "24 → 25 fps (×0.9600)" },
  { v: 24 / 23.976, label: "24 → 23.976 fps (×1.0010)" },
  { v: 23.976 / 24, label: "23.976 → 24 fps (×0.9990)" },
];

function sourceLabel(c: SubCandidate) {
  if (c.id.startsWith("file:")) return "Your file";
  return c.source === "embedded" ? "In video" : c.source === "sidecar" ? "Next to video" : "Online";
}

function statusText(status: SubStatus): string | null {
  switch (status.kind) {
    case "idle": return null;
    case "searching": return "Finding subtitles…";
    case "selected": return `${status.label} subtitles · ${status.detail}`;
    case "none": return status.detail;
    case "syncing": return `${status.deep ? "Deep-syncing" : "Syncing"} ${status.label} subtitles to dialogue…${status.progress ? ` ${status.progress}` : ""}`;
    case "synced": return status.segments && status.segments > 1
      ? `Synced to dialogue in ${status.segments} parts (the cut differs): ${status.detail ?? ""}${status.ratio !== 1 ? ` · fps ×${status.ratio.toFixed(4)}` : ""}`
      : `Synced to dialogue: ${signed(status.offset)} s${status.ratio !== 1 ? ` · fps ×${status.ratio.toFixed(4)}` : ""}`;
    case "in-sync": return "Subtitles already match the dialogue";
    case "sync-failed": return `Auto Sync: ${status.detail}${status.canRetry ? " · Try “Sync again (deeper)”" : ""}`;
  }
}

function SubtitlesTab({ sess, s, status, style, setStyle, onSelect, onLoadFile, onSync, setDelay, setSpeed, resetTiming }: {
  sess: SubtitleSession; s: PState; status: SubStatus; style: SubStyle; setStyle: (p: Partial<SubStyle>) => void;
  onSelect: (c: SubCandidate | null) => void; onLoadFile: () => void; onSync: () => void;
  setDelay: (v: number, quiet?: boolean) => void; setSpeed: (v: number) => void; resetTiming: () => void;
}) {
  const list = [...sess.ranked.map((r) => r.candidate), ...sess.candidates.filter((c) => !sess.ranked.some((r) => r.candidate.id === c.id))].slice(0, 60);
  const active = sess.activeCandidate();
  const syncing = status.kind === "syncing";
  const canSync = !!active && active.sid == null && s.sid != null && !syncing;
  const ratioKnown = RATIOS.find((r) => Math.abs(r.v - s.subSpeed) < 1e-4);
  const text = statusText(status);
  return (
    <>
      {text && (
        <div className={`kp-status kp-status-${status.kind}`} role="status">
          {syncing || status.kind === "searching" ? <Loader2 size={16} className="kp-spin" /> : status.kind === "synced" || status.kind === "in-sync" ? <Wand2 size={16} /> : <Captions size={16} />}
          <span>{text}</span>
        </div>
      )}

      <Section title="Subtitle track" action={<button className="kp-btn kp-btn-ghost" onClick={onLoadFile}><FileUp size={15} /> Load file</button>}>
        <div className="kp-list" role="radiogroup" aria-label="Subtitle track">
          <TrackRow active={s.sid == null} onClick={() => onSelect(null)} title="Off" />
          {list.length === 0 && <p className="kp-empty">{status.kind === "searching" ? "Looking for subtitles…" : "No subtitles found yet."}</p>}
          {list.map((c) => (
            <TrackRow
              key={c.id}
              active={sess.activeId === c.id && s.sid != null}
              onClick={() => onSelect(c)}
              title={c.lang ? langName(c.lang) : "Unknown language"}
              badges={
                <>
                  {c.mislabeledAs && <span className="kp-badge warn" title="The file's text does not match its label">Labelled {langName(c.mislabeledAs)}</span>}
                  {c.forced && <span className="kp-badge">Forced</span>}
                  {c.sdh && <span className="kp-badge">SDH</span>}
                  {isImageCodec(c.codec) && <span className="kp-badge">Image</span>}
                </>
              }
              detail={<><span className={`kp-src kp-src-${c.source}`}>{sourceLabel(c)}</span>{c.name ?? (c.label !== langName(c.lang) ? c.label : "")}</>}
            />
          ))}
        </div>
      </Section>

      <Section title="Timing" action={<button className="kp-btn kp-btn-ghost" onClick={resetTiming} disabled={s.subDelay === 0 && s.subSpeed === 1}><Undo2 size={15} /> Reset</button>}>
        <button className="kp-btn kp-btn-solid kp-wide" disabled={!canSync} onClick={onSync} title={active?.sid != null ? "Embedded subtitles are already timed with the video" : "Analyse the audio and align this subtitle"}>
          {syncing ? <Loader2 size={16} className="kp-spin" /> : <Wand2 size={16} />} {syncing ? "Syncing…" : sess.nextSyncIsDeep(active) ? "Sync again (deeper)" : "Auto sync now"}
        </button>
        <Field label="Delay" hint="Z / X">
          <Stepper value={`${signed(s.subDelay)} s`} onMinus={() => setDelay(s.subDelay - 0.1)} onPlus={() => setDelay(s.subDelay + 0.1)} minusLabel="Show earlier (Z)" plusLabel="Show later (X)" wide />
        </Field>
        <Range min={-10} max={10} step={0.05} value={s.subDelay} onChange={(v) => setDelay(v, true)} label="Subtitle delay" mark={0} className="kp-full" />
        <Field label="Speed ratio" hint="For subtitles made for another frame rate">
          <select className="kp-select" value={ratioKnown ? String(ratioKnown.v) : "custom"} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Subtitle speed ratio">
            {RATIOS.map((r) => <option key={r.v} value={String(r.v)}>{r.label}</option>)}
            {!ratioKnown && <option value="custom" disabled>Auto Sync ×{s.subSpeed.toFixed(4)}</option>}
          </select>
        </Field>
      </Section>

      <Section title="Style" action={<button className="kp-btn kp-btn-ghost" onClick={() => setStyle(DEFAULT_STYLE)}><Undo2 size={15} /> Default</button>}>
        <Field label="Size" hint={style.size}>
          <Range min={30} max={90} step={1} value={style.size} onChange={(v) => setStyle({ size: v })} label="Subtitle size" />
        </Field>
        <Field label="Font">
          <select className="kp-select" value={style.font} onChange={(e) => setStyle({ font: e.target.value })} aria-label="Subtitle font">
            {SUBTITLE_FONTS.map((f) => <option key={f.family} value={f.family}>{f.label}</option>)}
          </select>
        </Field>
        <Field label="Bold"><Switch checked={style.bold} onChange={(v) => setStyle({ bold: v })} label="Bold" /></Field>
        <Field label="Text colour">
          <Swatches value={style.color} options={["#ffffff", "#fff3a3", "#ffd23f", "#9ee7ff", "#b6f5a6"]} onChange={(c) => setStyle({ color: c })} label="Text colour" />
        </Field>
        <Field label="Text opacity" hint={`${Math.round(style.opacity * 100)}%`}>
          <Range min={0.2} max={1} step={0.05} value={style.opacity} onChange={(v) => setStyle({ opacity: v })} label="Text opacity" />
        </Field>
        <Field label="Outline" disabled={style.background} hint={style.background ? "Off with the box" : undefined}>
          <Switch checked={style.outlineOn} onChange={(v) => setStyle({ outlineOn: v })} label="Outline" />
        </Field>
        <Field label="Outline colour" disabled={style.background || !style.outlineOn}>
          <Swatches value={style.outlineColor} options={["#000000", "#1f2933", "#3b2a00", "#0b2c4a"]} onChange={(c) => setStyle({ outlineColor: c })} label="Outline colour" disabled={style.background || !style.outlineOn} />
        </Field>
        <Field label="Outline width" hint={style.outline} disabled={style.background || !style.outlineOn}>
          <Range min={0} max={6} step={0.5} value={style.outline} onChange={(v) => setStyle({ outline: v })} label="Outline width" disabled={style.background || !style.outlineOn} />
        </Field>
        <Field label="Background box"><Switch checked={style.background} onChange={(v) => setStyle({ background: v })} label="Background box" /></Field>
        <Field label="Box opacity" hint={`${Math.round(style.backgroundOpacity * 100)}%`} disabled={!style.background}>
          <Range min={0.1} max={1} step={0.05} value={style.backgroundOpacity} onChange={(v) => setStyle({ backgroundOpacity: v })} label="Box opacity" disabled={!style.background} />
        </Field>
        <Field label="Vertical position" hint={style.position === 100 ? "Bottom" : style.position}>
          <Range min={50} max={100} step={1} value={style.position} onChange={(v) => setStyle({ position: v })} label="Vertical position" />
        </Field>
        <Field label="Restyle ASS subtitles" hint="Force your style on styled (anime) subtitles">
          <Switch checked={style.overrideAss} onChange={(v) => setStyle({ overrideAss: v })} label="Override ASS styles" />
        </Field>
        <p className="kp-note">Right-to-left text (Arabic, Persian, Hebrew) is shaped and ordered automatically. Changes apply now and are saved for every video.</p>
      </Section>
    </>
  );
}

function TrackRow({ active, onClick, title, badges, detail }: { active: boolean; onClick: () => void; title: ReactNode; badges?: ReactNode; detail?: ReactNode }) {
  return (
    <button className={`kp-track ${active ? "on" : ""}`} role="radio" aria-checked={active} onClick={onClick}>
      <span className="kp-radio" aria-hidden>{active && <Check size={13} strokeWidth={3} />}</span>
      <span className="kp-track-text">
        <span className="kp-track-title">{title}{badges}</span>
        {detail && <small>{detail}</small>}
      </span>
    </button>
  );
}

/* ───────────────────────────── Audio tab ───────────────────────────── */

function channelsLabel(t: MpvTrack): string | null {
  const layout = t["demux-channels"];
  const n = t["demux-channel-count"];
  if (layout && /^\d\.\d/.test(layout)) return layout.replace(/\(.*\)/, "");
  if (layout === "stereo" || n === 2) return "Stereo";
  if (layout === "mono" || n === 1) return "Mono";
  return n ? `${n} ch` : layout ?? null;
}

function AudioTab({ tracks, aid, volume, setVolume, delay, setDelay, normalize, setNormalize }: {
  tracks: MpvTrack[]; aid: number | null; volume: number; setVolume: (v: number) => void;
  delay: number; setDelay: (v: number) => void; normalize: boolean; setNormalize: (v: boolean) => void;
}) {
  return (
    <>
      <Section title="Audio track">
        <div className="kp-list" role="radiogroup" aria-label="Audio track">
          {tracks.length === 0 && <p className="kp-empty">No audio tracks.</p>}
          {tracks.map((t) => {
            const lang = langName(t.lang);
            const rate = t["demux-samplerate"] ? `${(t["demux-samplerate"] / 1000).toFixed(1).replace(/\.0$/, "")} kHz` : null;
            return (
              <TrackRow
                key={t.id}
                active={aid === t.id}
                onClick={() => void player.set("aid", t.id)}
                title={lang !== "Unknown" ? lang : `Track ${t.id}`}
                badges={<>{t.default && <span className="kp-badge">Default</span>}{t.external && <span className="kp-badge">External</span>}</>}
                detail={[t.title, t.codec?.toUpperCase(), channelsLabel(t), rate].filter(Boolean).join(" · ")}
              />
            );
          })}
        </div>
      </Section>
      <Section title="Sound">
        <Field label="Volume" hint={`${Math.round(volume)}%${volume > 100 ? " · boost" : ""}`}>
          <Range min={0} max={VOLUME_MAX} step={1} value={volume} onChange={setVolume} label="Volume" mark={100} />
        </Field>
        <Field label="Normalise loudness" hint="Evens out quiet dialogue and loud scenes">
          <Switch checked={normalize} onChange={setNormalize} label="Normalise loudness" />
        </Field>
        <Field label="Audio delay" hint="Fix lip-sync">
          <Stepper value={`${signed(delay)} s`} onMinus={() => setDelay(delay - 0.05)} onPlus={() => setDelay(delay + 0.05)} minusLabel="Audio earlier" plusLabel="Audio later" wide />
        </Field>
        <Range min={-5} max={5} step={0.05} value={delay} onChange={setDelay} label="Audio delay" mark={0} className="kp-full" />
        {delay !== 0 && <button className="kp-btn kp-btn-ghost" onClick={() => setDelay(0)}><Undo2 size={15} /> Reset delay</button>}
      </Section>
    </>
  );
}

/* ───────────────────────────── Playback tab ───────────────────────────── */

type VideoInfo = Partial<Record<"width" | "height" | "video-codec" | "hwdec-current" | "container-fps" | "estimated-vf-fps" | "frame-drop-count" | "decoder-frame-drop-count" | "video-bitrate" | "audio-codec-name", unknown>>;
const INFO_PROPS = ["width", "height", "video-codec", "hwdec-current", "container-fps", "estimated-vf-fps", "frame-drop-count", "decoder-frame-drop-count", "video-bitrate", "audio-codec-name"] as const;

function useVideoInfo(): VideoInfo {
  const [info, setInfo] = useState<VideoInfo>({});
  useEffect(() => {
    let live = true;
    const poll = async () => {
      const vals = await Promise.all(INFO_PROPS.map((p) => player.get(p).catch(() => null)));
      if (live) setInfo(Object.fromEntries(INFO_PROPS.map((p, i) => [p, vals[i]])));
    };
    void poll();
    const t = window.setInterval(() => void poll(), 1000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);
  return info;
}

const HWDEC_NAMES: Record<string, string> = { vaapi: "VA-API", "vaapi-copy": "VA-API (copy)", nvdec: "NVDEC", "nvdec-copy": "NVDEC (copy)", vdpau: "VDPAU", cuda: "CUDA", vulkan: "Vulkan" };

function PlaybackTab({ speed, setSpeed, defaultPlayer, onHandOff }: { speed: number; setSpeed: (v: number) => void; defaultPlayer: string; onHandOff: (id: string) => void }) {
  const info = useVideoInfo();
  const players = useExternalPlayers();
  const sorted = useMemo(() => [...(players ?? [])].sort((a, b) => Number(b.id === defaultPlayer) - Number(a.id === defaultPlayer)), [players, defaultPlayer]);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const w = n(info.width), h = n(info.height);
  const fps = n(info["estimated-vf-fps"]) ?? n(info["container-fps"]);
  const hw = typeof info["hwdec-current"] === "string" ? info["hwdec-current"] : null;
  const dropped = (n(info["frame-drop-count"]) ?? 0) + (n(info["decoder-frame-drop-count"]) ?? 0);
  const bitrate = n(info["video-bitrate"]);
  const rows: [string, string][] = [
    ["Resolution", w && h ? `${w} × ${h}${h >= 2000 ? " · 4K" : h >= 1000 ? " · 1080p" : h >= 700 ? " · 720p" : ""}` : "—"],
    ["Video codec", typeof info["video-codec"] === "string" ? String(info["video-codec"]).split(" (")[0].toUpperCase() : "—"],
    ["Frame rate", fps ? `${fps.toFixed(3).replace(/\.?0+$/, "")} fps` : "—"],
    ["Hardware decoding", hw == null ? "—" : hw === "no" || hw === "" ? "Off (software)" : HWDEC_NAMES[hw] ?? hw],
    ["Dropped frames", String(dropped)],
    ["Video bitrate", bitrate ? `${(bitrate / 1e6).toFixed(1)} Mb/s` : "—"],
    ["Audio codec", typeof info["audio-codec-name"] === "string" ? String(info["audio-codec-name"]).toUpperCase() : "—"],
  ];
  return (
    <>
      <Section title="Speed" action={speed !== 1 ? <button className="kp-btn kp-btn-ghost" onClick={() => setSpeed(1)}><Undo2 size={15} /> Normal</button> : undefined}>
        <div className="kp-chips" role="radiogroup" aria-label="Playback speed">
          {SPEEDS.map((v) => (
            <button key={v} role="radio" aria-checked={Math.abs(speed - v) < 0.001} className={`kp-chip ${Math.abs(speed - v) < 0.001 ? "on" : ""}`} onClick={() => setSpeed(v)}>
              {v === 1 ? "Normal" : `${v}×`}
            </button>
          ))}
        </div>
        <Field label="Custom" hint={`${speed.toFixed(2)}×`}>
          <Range min={0.5} max={2} step={0.05} value={speed} onChange={setSpeed} label="Playback speed" mark={1} />
        </Field>
      </Section>

      <Section title="Open in another player">
        {players == null ? (
          <p className="kp-empty">Looking for installed players…</p>
        ) : sorted.length === 0 ? (
          <p className="kp-empty">No external players found. mpv, VLC, Celluloid, SMPlayer and Haruna are supported, including Flatpak installs.</p>
        ) : (
          <div className="kp-handoff">
            {sorted.map((p) => (
              <button key={p.id} className="kp-btn kp-btn-tile" onClick={() => onHandOff(p.id)} title={p.command}>
                <ExternalLink size={16} />
                <span>Open in {p.name}</span>
                {p.id === defaultPlayer && <span className="kp-badge">Default</span>}
              </button>
            ))}
            <p className="kp-note">Continues from the current position with the selected subtitle. Kinly pauses here.</p>
          </div>
        )}
      </Section>

      <Section title="Video info">
        <dl className="kp-info">
          {rows.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      </Section>
    </>
  );
}

/* ───────────────────────────── Bar pieces ───────────────────────────── */

function TimeLabel({ clock, duration }: { clock: ClockStore; duration: number }) {
  const sec = useClock(clock, (c) => Math.floor(c.time));
  const [remaining, setRemaining] = useState(false);
  return (
    <button className="kp-time" onClick={() => setRemaining((r) => !r)} title="Show remaining time">
      {remaining && duration > 0 ? `−${fmtTime(duration - sec)}` : fmtTime(sec)}
      <span> / {fmtTime(duration)}</span>
    </button>
  );
}

const SEG_NAMES: Record<string, string> = { intro: "Intro", recap: "Recap", credits: "Credits", preview: "Preview" };

const SeekBar = memo(function SeekBar({ clock, duration, segments, onSeek }: { clock: ClockStore; duration: number; segments: Segment[]; onSeek: (t: number) => void }) {
  const time = useClock(clock, (c) => c.time);
  const cache = useClock(clock, (c) => c.cache);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const f = clamp((clientX - r.left) / r.width, 0, 1);
    return { x: f * r.width, t: f * duration };
  };
  // Fill, buffer and knob move by transform only: progress ticks never trigger layout.
  const shown = drag ?? time;
  const frac = duration > 0 ? Math.min(1, shown / duration) : 0;
  const buf = duration > 0 ? Math.min(1, Math.max(cache, time) / duration) : 0;
  const hoverSeg = hover ? segments.find((g) => hover.t >= g.startSec && hover.t < (g.endSec ?? duration)) : undefined;
  return (
    <div
      className={`kp-seek ${drag != null ? "dragging" : ""}`}
      ref={ref}
      onPointerDown={(e) => {
        if (duration <= 0 || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(at(e.clientX).t);
      }}
      onPointerMove={(e) => {
        if (duration <= 0) return;
        const p = at(e.clientX);
        setHover(p);
        if (drag != null) setDrag(p.t);
      }}
      onPointerUp={(e) => {
        if (drag == null) return;
        onSeek(at(e.clientX).t);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => drag == null && setHover(null)}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${fmtTime(time)} of ${fmtTime(duration)}`}
    >
      <div className="kp-seek-track">
        <div className="kp-seek-buffer" style={{ transform: `scaleX(${buf})` }} />
        {duration > 0 &&
          segments.map((g) => (
            <div key={g.startSec} className={`kp-seek-seg seg-${g.kind}`} style={{ left: `${(g.startSec / duration) * 100}%`, width: `${(((g.endSec ?? duration) - g.startSec) / duration) * 100}%` }} title={SEG_NAMES[g.kind]} />
          ))}
        <div className="kp-seek-fill" style={{ transform: `scaleX(${frac})` }} />
      </div>
      <div className="kp-seek-rail" style={{ transform: `translateX(${frac * 100}%)` }}><span className="kp-seek-knob" /></div>
      {hover && (
        <div className="kp-seek-hover" style={{ transform: `translateX(${hover.x}px) translateX(-50%)` }}>
          {hoverSeg && <small>{SEG_NAMES[hoverSeg.kind]}</small>}
          {fmtTime(hover.t)}
        </div>
      )}
    </div>
  );
});

/** "Skip intro" / "Next episode" pill; re-renders only when the active segment changes. */
function SkipButton({ clock, segments, hasNext, showCredits, lifted, onSkip }: {
  clock: ClockStore; segments: Segment[]; hasNext: boolean; showCredits: boolean; lifted: boolean; onSkip: (s: Segment) => void;
}) {
  const seg = useClock(clock, (c) => activeSegment(segments, c.time));
  if (!seg || (seg.kind === "credits" && !showCredits)) return null;
  return (
    <button key={seg.startSec} className={`kp-skip ${lifted ? "lifted" : ""}`} onClick={(e) => { e.stopPropagation(); onSkip(seg); }} onDoubleClick={(e) => e.stopPropagation()}>
      {seg.kind === "credits" && hasNext ? <SkipForward size={18} /> : <ChevronsRight size={18} />}
      {skipLabel(seg.kind, hasNext)}
    </button>
  );
}

function SubStatusChip({ status, hidden }: { status: SubStatus; hidden: boolean }) {
  const text = statusText(status);
  if (hidden || !text) return null;
  const icon = status.kind === "syncing" || status.kind === "searching" ? <Loader2 size={15} className="kp-spin" /> : status.kind === "synced" || status.kind === "in-sync" ? <Wand2 size={15} /> : <Captions size={15} />;
  return <div className={`kp-chipstatus kp-status-${status.kind}`} role="status">{icon}{text}</div>;
}
