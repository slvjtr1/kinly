import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { onPlayerEvent, onPlayerProp, player } from "../lib/tauri";
import { YTDLP_MISSING, embedUrl, resolveTrailer, type Trailer } from "../lib/trailers";
import { useApp } from "../state";
import { errorMessage } from "../components/ui";
import "../styles/detail.css";

type Phase = "resolving" | "playing" | "embed";

const fmt = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * Plays a title's trailer inside Kinly: in the built-in player (libmpv) when yt-dlp can resolve
 * it, otherwise in an in-app YouTube embed. Nothing is saved: no progress, no history, no Trakt
 * scrobble. Closing it (Esc, Back, or the end of the trailer) returns to the page underneath,
 * which stays mounted (hidden) so its scroll position and state are kept.
 */
export default function TrailerPlayer({ trailer, title, backdrop, onClose }: { trailer: Trailer; title: string; backdrop?: string; onClose: () => void }) {
  const { settings } = useApp();
  const [phase, setPhase] = useState<Phase>("resolving");
  const [note, setNote] = useState<string | null>(null);
  // The first trailer downloads Kinly's trailer helper; say so if it takes a moment.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 4000);
    return () => window.clearTimeout(t);
  }, []);
  const streamRef = useRef<{ video: string; audio: string | null } | null>(null);
  const toEmbed = useCallback((why: string | null) => {
    setNote(why);
    setPhase("embed");
  }, []);

  useEffect(() => {
    let live = true;
    resolveTrailer(trailer.ytId)
      .then((s) => {
        if (!live) return;
        streamRef.current = s;
        setPhase("playing");
      })
      .catch((e) => live && toEmbed(errorMessage(e) === YTDLP_MISSING ? "Kinly couldn't download its trailer helper, so this trailer plays from YouTube. Check your internet connection and try again." : "This trailer couldn't play in Kinly's player, so it plays from YouTube."));
    return () => {
      live = false;
    };
  }, [trailer.ytId, toEmbed]);

  // Keys go to the trailer only (the app's own shortcuts, like "/" for search, are held back).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") return;
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        onClose();
      }
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className={`trailer-layer phase-${phase}`} role="dialog" aria-modal="true" aria-label={`${title} trailer`}>
      {phase === "resolving" && (
        <div className="trailer-loading">
          {backdrop && <img src={backdrop} alt="" decoding="async" />}
          <div className="trailer-loading-inner">
            <div className="spinner" />
            <div className="trailer-kicker">Trailer</div>
            <div className="trailer-name">{title}</div>
            {slow && <div className="trailer-hint">Getting the trailer player ready…</div>}
          </div>
          <button className="btn glass trailer-close" onClick={onClose}><X size={18} /> Close</button>
        </div>
      )}
      {phase === "playing" && streamRef.current && (
        <NativeTrailer stream={streamRef.current} title={title} volume={settings.playback.volume} onClose={onClose} onFail={() => toEmbed("This trailer could not play in Kinly's player, so it plays from YouTube.")} />
      )}
      {phase === "embed" && (
        <div className="trailer-embed" onClick={onClose}>
          <div className="trailer-embed-box" onClick={(e) => e.stopPropagation()}>
            <div className="trailer-embed-head">
              <div style={{ minWidth: 0 }}>
                <div className="trailer-kicker">Trailer</div>
                <div className="trailer-name">{title}</div>
              </div>
              <button className="icon-btn" onClick={onClose} aria-label="Close trailer"><X size={20} /></button>
            </div>
            <div className="trailer-frame">
              <iframe
                src={embedUrl(trailer.ytId)}
                title={`${title} trailer`}
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>
            {note && <p className="faint trailer-note">{note}</p>}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

/** The trailer in libmpv, with a small control bar. */
function NativeTrailer({ stream, title, volume, onClose, onFail }: {
  stream: { video: string; audio: string | null }; title: string; volume: number; onClose: () => void; onFail: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const closeRef = useRef(onClose);
  const failRef = useRef(onFail);
  closeRef.current = onClose;
  failRef.current = onFail;

  useEffect(() => {
    document.body.classList.add("playing", "trailer-open");
    let live = true;
    let loaded = false;
    const un: (() => void)[] = [];
    const guard = window.setTimeout(() => live && !loaded && failRef.current(), 25_000);
    (async () => {
      un.push(
        await onPlayerProp(({ name, value }) => {
          if (!live) return;
          if (name === "time-pos") setTime(Number(value) || 0);
          else if (name === "duration") setDuration(Number(value) || 0);
          else if (name === "pause") setPaused(!!value);
          else if (name === "mute") setMuted(!!value);
          else if (name === "eof-reached" && value === true && loaded) closeRef.current();
        }),
      );
      un.push(
        await onPlayerEvent((e) => {
          if (!live) return;
          if (e.type === "file-loaded") {
            loaded = true;
            if (stream.audio) void player.command("audio-add", stream.audio, "select").catch(() => {});
          }
          if (e.type === "playback-restart") setReady(true);
          if (e.type === "error" || (e.type === "end-file" && !loaded)) failRef.current();
        }),
      );
      if (!live) return;
      try {
        await player.load(stream.video, { title: `${title} · Trailer` });
        await player.setMany([["volume", Math.min(100, volume)], ["mute", false], ["speed", 1]]);
      } catch {
        if (live) failRef.current();
      }
    })();
    return () => {
      live = false;
      window.clearTimeout(guard);
      un.forEach((u) => u());
      void player.stop();
      document.body.classList.remove("playing", "trailer-open");
    };
    // The stream does not change while this is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2600);
  }, []);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [wake]);

  const toggle = useCallback(() => void player.command("cycle", "pause"), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === " " || k === "k") void player.command("cycle", "pause");
      else if (k === "ArrowRight") void player.command("seek", 5);
      else if (k === "ArrowLeft") void player.command("seek", -5);
      else if (k === "m") void player.command("cycle", "mute");
      else return; // Esc and Back are handled by the layer; other keys are held back there.
      e.preventDefault();
      e.stopImmediatePropagation();
      wake();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [wake]);

  const seekTo = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!(duration > 0)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    void player.command("seek", (f * duration).toFixed(2), "absolute");
  };

  return (
    <div className={`trailer-native ${idle && ready && !paused ? "idle" : ""}`} onPointerMove={wake} onPointerDown={wake}>
      <div className="trailer-hit" onClick={toggle} />
      {!ready && <div className="trailer-buffering"><div className="spinner" /></div>}
      <div className="trailer-top">
        <button className="btn glass" onClick={onClose}><ArrowLeft size={18} /> Back</button>
        <div className="trailer-top-title">
          <span className="trailer-kicker">Trailer</span>
          <span className="trailer-name">{title}</span>
        </div>
      </div>
      <div className="trailer-bottom">
        <button className="icon-btn" onClick={toggle} aria-label={paused ? "Play" : "Pause"}>{paused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}</button>
        <span className="trailer-time">{fmt(time)}</span>
        <div className="trailer-seek" onPointerDown={seekTo} role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}>
          <i style={{ transform: `scaleX(${duration > 0 ? Math.min(1, time / duration) : 0})` }} />
        </div>
        <span className="trailer-time">{fmt(duration)}</span>
        <button className="icon-btn" onClick={() => void player.command("cycle", "mute")} aria-label={muted ? "Unmute" : "Mute"}>{muted ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
      </div>
    </div>
  );
}
