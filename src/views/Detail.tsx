import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { trapDialogFocus } from "../lib/spatialNav";
import {
  AlertTriangle, ArrowLeft, AudioLines, Check, CheckCheck, Clapperboard, Cpu, Disc3, Download, ExternalLink, Eye, Globe, HardDrive, Play, Plus, Sparkles,
  SunMedium, Tv, Video as VideoIcon, X,
} from "lucide-react";
import { isExternalDefault, openExternally } from "../lib/extplayer";
import { rankCapsFor, useCaps } from "../lib/caps";
import { getMeta, getStreams, type Meta, type Video } from "../lib/addons";
import { getProgress, inWatchlist, markWatched, progressKey, toggleWatchlist, type Progress } from "../lib/library";
import { QUALITY_LABEL, downloadName, formatBytes, qualityGroup, rankStreams, type QualityGroup, type RankedStream, type StreamTag } from "../lib/streams";
import { imdbIdFor, moreLikeThis, subscribeCredentials, tmdbKey, type Recommendation } from "../lib/tmdb";
import { trailersOf } from "../lib/trailers";
import { useAddons } from "../lib/useAddons";
import { useApp } from "../state";
import { Empty, ErrorState, ImdbRating, Loading, Poster, PrismHint, errorMessage } from "../components/ui";
import { downloadStart } from "../lib/tauri";
import { useLibraryVersion } from "./Home";
import TrailerPlayer from "./TrailerPlayer";
import type { PlayRequest } from "./Player";
import "../styles/library.css";
import "../styles/detail.css";

/**
 * Starts playback of a request: in the built-in player, or in the external player chosen in
 * Settings → Playback (`settings.playback.player !== "builtin"`).
 */
export function useStartPlayback() {
  const { navigate, settings, toast } = useApp();
  const player = settings.playback.player;
  return useCallback(
    (req: PlayRequest) => {
      if (!isExternalDefault(player)) return navigate({ name: "player", req });
      openExternally(req, req.startSec, { player })
        .then((p) => toast(`Playing in ${p.name}`))
        .catch((e) => toast(errorMessage(e), "error"));
    },
    [navigate, player, toast],
  );
}

export function sortedEpisodes(meta: Meta): Video[] {
  return (meta.videos ?? [])
    .filter((v) => v.season != null && v.episode != null)
    .sort((a, b) => (a.season! - b.season!) || (a.episode! - b.episode!));
}

export function nextEpisode(meta: Meta, videoId: string): Video | null {
  const eps = sortedEpisodes(meta).filter((v) => v.season! > 0);
  const i = eps.findIndex((v) => v.id === videoId);
  return i >= 0 && i + 1 < eps.length ? eps[i + 1] : null;
}

/** The episode the Play button should open: an unfinished one, else the one after the last watched, else the first. */
export function resumeEpisode(meta: Meta, progressOf: (videoId: string) => Progress | undefined): Video | null {
  const eps = sortedEpisodes(meta).filter((v) => v.season! > 0);
  const latest = eps
    .map((v) => ({ v, p: progressOf(v.id) }))
    .filter((x) => x.p)
    .sort((a, b) => b.p!.updatedAt - a.p!.updatedAt)[0];
  if (!latest) return eps[0] ?? null;
  return latest.p!.watched ? nextEpisode(meta, latest.v.id) ?? latest.v : latest.v;
}

export function buildPlayRequest(meta: Meta, rs: RankedStream, video: Video | null, resume: boolean): PlayRequest {
  const videoId = video?.id ?? meta.id;
  const prog = getProgress(progressKey(meta.type, videoId));
  const next = video ? nextEpisode(meta, video.id) : null;
  return {
    url: rs.stream.url!,
    title: meta.name,
    metaId: meta.id,
    type: meta.type,
    videoId,
    season: video?.season,
    episode: video?.episode,
    episodeTitle: video?.title ?? video?.name,
    poster: meta.poster,
    background: meta.background,
    filename: rs.stream.behaviorHints?.filename ?? rs.detail,
    videoSize: rs.stream.behaviorHints?.videoSize,
    headers: rs.stream.behaviorHints?.proxyHeaders?.request,
    bingeGroup: rs.stream.behaviorHints?.bingeGroup,
    year: Number(meta.releaseInfo?.slice(0, 4)) || undefined,
    startSec: resume && prog && !prog.watched && prog.position > 30 ? Math.max(0, prog.position - 3) : undefined,
    next: next ? { videoId: next.id, season: next.season!, episode: next.episode!, title: next.title ?? next.name } : null,
  };
}

export default function Detail({ type, id }: { type: string; id: string }) {
  const { addons } = useAddons();
  const { back } = useApp();
  useLibraryVersion();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [sources, setSources] = useState<{ video: Video | null; mode: SourcesMode } | null>(null);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setMeta(null);
    setError(null);
    getMeta(addons, type, id)
      .then((m) => {
        if (!live) return;
        const ep = sortedEpisodes(m).length ? resumeEpisode(m, (v) => getProgress(progressKey(type, v))) : null;
        // The whole page renders at once here; as a transition it yields to the spinner and input.
        startTransition(() => {
          setMeta(m);
          if (ep) setSeason(ep.season!);
        });
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [addons, type, id, attempt]);

  const episodes = useMemo(() => (meta ? sortedEpisodes(meta) : []), [meta]);
  const seasons = useMemo(() => [...new Set(episodes.map((v) => v.season!))].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b)), [episodes]);
  const trailers = useMemo(() => trailersOf(meta), [meta]);
  const isSeries = episodes.length > 0;

  if (error) return <div className="page"><BackBar onBack={back} /><ErrorState title="Could not load this title" detail={error} onRetry={() => setAttempt((a) => a + 1)} /></div>;
  if (!meta) return <div className="page"><BackBar onBack={back} /><Loading /></div>;

  const saved = inWatchlist(meta.id);
  const resumeEp = isSeries ? resumeEpisode(meta, (v) => getProgress(progressKey(meta.type, v))) : null;
  const resumeProg = getProgress(progressKey(meta.type, resumeEp?.id ?? meta.id));
  const resuming = !!resumeProg && !resumeProg.watched && resumeProg.position > 30;
  const playLabel = isSeries && resumeEp ? `${resuming ? "Resume" : "Play"} S${resumeEp.season} · E${resumeEp.episode}` : resuming ? "Resume" : "Play";
  const left = resuming && resumeProg.duration > 0 ? Math.max(1, Math.round((resumeProg.duration - resumeProg.position) / 60)) : 0;
  const seasonCount = seasons.filter((s) => s > 0).length;
  const runtime = formatRuntime(meta.runtime);
  const year = meta.releaseInfo;
  const extra = meta as Meta & { writer?: string[]; awards?: string; released?: string };

  return (
    <div className="tp">
      <section className="tp-hero">
        {meta.background && (
          <div className="tp-backdrop">
            <img src={meta.background} alt="" decoding="async" fetchPriority="high" onError={hideBroken} />
          </div>
        )}
        <div className="tp-hero-inner">
          <BackBar onBack={back} />
          <div className="tp-hero-main">
            <div className="tp-copy">
              <div className="tp-kicker">
                {isSeries ? "Series" : "Movie"}
                {isSeries && seasonCount > 0 && <span>{seasonCount} season{seasonCount === 1 ? "" : "s"}</span>}
              </div>
              <TitleArt logo={meta.logo} name={meta.name} imgClass="tp-logo" titleClass="tp-title" />
              <div className="tp-meta">
                {year && <span>{year}</span>}
                {runtime && <span>{runtime}</span>}
                {extra.country && <span className="tp-country">{extra.country.split(",")[0]}</span>}
                <ImdbRating value={meta.imdbRating} />
                {/^tt\d+$/.test(meta.id) && (
                  <button className="tp-imdb-link" onClick={() => void openUrl(`https://www.imdb.com/title/${meta.id}/`)} title="Open on IMDb">
                    IMDb <ExternalLink size={12} />
                  </button>
                )}
              </div>
              {meta.genres?.length ? <div className="tp-genres">{meta.genres.slice(0, 4).map((g) => <span key={g}>{g}</span>)}</div> : null}
              {meta.description && <p className="tp-synopsis">{meta.description}</p>}
              <div className="tp-actions">
                <button className="btn primary large tp-play" onClick={() => setSources({ video: resumeEp, mode: "play" })} disabled={isSeries && !resumeEp}>
                  <Play size={20} fill="currentColor" /> {playLabel}
                </button>
                {trailers.length > 0 && (
                  <button className="btn glass large" onClick={() => setTrailerOpen(true)}>
                    <Clapperboard size={19} /> Trailer
                  </button>
                )}
                <IconAction
                  label={saved ? "In library" : "Add to library"}
                  active={saved}
                  onClick={() => toggleWatchlist({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster })}
                  icon={saved ? <Check size={19} /> : <Plus size={19} />}
                />
                <IconAction label="Download" onClick={() => setSources({ video: resumeEp, mode: "download" })} icon={<Download size={19} />} disabled={isSeries && !resumeEp} />
                {resumeProg && (
                  <IconAction
                    label={resumeProg.watched ? "Watched" : "Mark watched"}
                    active={resumeProg.watched}
                    onClick={() => markWatched(resumeProg.key, !resumeProg.watched)}
                    icon={resumeProg.watched ? <CheckCheck size={19} /> : <Eye size={19} />}
                  />
                )}
              </div>
              {resuming && resumeProg.duration > 0 && (
                <div className="tp-resume">
                  <div className="tp-resume-bar"><i style={{ transform: `scaleX(${Math.min(1, resumeProg.position / resumeProg.duration)})` }} /></div>
                  <span>{left} min left{isSeries && resumeEp ? ` in S${resumeEp.season} · E${resumeEp.episode}` : ""}</span>
                </div>
              )}
            </div>
            <div className="tp-poster" aria-hidden="true"><Poster src={meta.poster} title={meta.name} eager /></div>
          </div>
        </div>
      </section>

      <div className="page tp-body">
        {isSeries && (
          <EpisodeBrowser
            meta={meta}
            episodes={episodes}
            seasons={seasons}
            season={season ?? seasons[0]}
            onSeason={setSeason}
            current={resumeEp?.id}
            onPlay={(v) => setSources({ video: v, mode: "play" })}
          />
        )}
        <CastAndCrew cast={meta.cast} director={meta.director} writer={extra.writer} />
        <About meta={meta} awards={extra.awards} released={extra.released} />
        <MoreLikeThis meta={meta} />
      </div>

      {sources && <SourcesPanel meta={meta} video={sources.video} mode={sources.mode} onClose={() => setSources(null)} />}
      {trailerOpen && trailers[0] && <TrailerPlayer trailer={trailers[0]} title={meta.name} backdrop={meta.background} onClose={() => setTrailerOpen(false)} />}
    </div>
  );
}

/** Hides an image whose file failed to load (no broken-image icon); what is under it shows. */
export const hideBroken = (e: SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.visibility = "hidden";
};

/** The title's logo, or its name as a heading when there is no logo or it fails to load. */
export function TitleArt({ logo, name, imgClass, titleClass }: { logo?: string; name: string; imgClass: string; titleClass: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!logo || failed === logo) return <h1 className={titleClass}>{name}</h1>;
  return <img className={imgClass} src={logo} alt={name} decoding="async" draggable={false} onError={() => setFailed(logo)} />;
}

/** "148 min" → "2h 28m"; other formats pass through. */
export function formatRuntime(r?: string): string | null {
  if (!r) return null;
  const m = /^\s*(\d+)\s*min/i.exec(r);
  if (!m) return r;
  const n = Number(m[1]);
  return n >= 60 ? `${Math.floor(n / 60)}h ${String(n % 60).padStart(2, "0")}m` : `${n}m`;
}

function IconAction({ label, icon, onClick, active, disabled }: { label: string; icon: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button className={`tp-icon-action ${active ? "active" : ""}`} onClick={onClick} disabled={disabled} aria-pressed={active}>
      <span className="tp-icon-circle">{icon}</span>
      <span className="tp-icon-label">{label}</span>
    </button>
  );
}

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <button className="btn glass back-btn" onClick={onBack}>
      <ArrowLeft size={18} /> Back
    </button>
  );
}

function EpisodeBrowser({ meta, episodes, seasons, season, onSeason, current, onPlay }: {
  meta: Meta; episodes: Video[]; seasons: number[]; season: number; onSeason: (s: number) => void; current?: string; onPlay: (v: Video) => void;
}) {
  const list = episodes.filter((v) => v.season === season);
  const progress = list.map((v) => getProgress(progressKey(meta.type, v.id)));
  const watched = progress.filter((p) => p?.watched).length;
  const now = Date.now();
  return (
    <section className="tp-section" aria-label="Episodes">
      <div className="tp-section-head">
        <h2>Episodes</h2>
        <div className="tp-season-progress" title={`${watched} of ${list.length} watched`}>
          <div className="tp-season-bar"><i style={{ transform: `scaleX(${list.length ? watched / list.length : 0})` }} /></div>
          <span>{watched} / {list.length} watched</span>
        </div>
      </div>
      <div className="tp-seasons" role="tablist" aria-label="Seasons">
        {seasons.map((s) => (
          <button key={s} role="tab" aria-selected={s === season} className={`tp-season ${s === season ? "active" : ""}`} onClick={() => onSeason(s)}>
            {s === 0 ? "Specials" : `Season ${s}`}
          </button>
        ))}
      </div>
      <div className="tp-episodes">
        {list.map((v, i) => {
          const p = progress[i];
          const upcoming = !!v.released && Date.parse(v.released) > now;
          return (
            <div key={v.id} className={`tp-ep ${v.id === current ? "current" : ""} ${p?.watched ? "watched" : ""}`}>
              <button className="tp-ep-main" onClick={() => onPlay(v)}>
                <div className="tp-ep-thumb">
                  <span className="tp-ep-thumb-num">{v.episode}</span>
                  {v.thumbnail && <img src={v.thumbnail} alt="" width={320} height={180} loading="lazy" decoding="async" onError={hideBroken} />}
                  <span className="tp-ep-play"><Play size={18} fill="currentColor" /></span>
                  {p && !p.watched && p.duration > 0 && <div className="tp-ep-progress"><i style={{ transform: `scaleX(${Math.min(1, p.position / p.duration)})` }} /></div>}
                </div>
                <div className="tp-ep-text">
                  <div className="tp-ep-title">
                    <span className="tp-ep-num">{v.episode}</span>
                    <span className="tp-ep-name">{v.title ?? v.name ?? `Episode ${v.episode}`}</span>
                  </div>
                  <div className="tp-ep-sub">
                    {upcoming ? <span className="tp-ep-upcoming">Coming {new Date(v.released!).toLocaleDateString()}</span> : v.released ? new Date(v.released).toLocaleDateString() : null}
                    {v.id === current && !p?.watched && <span className="tp-ep-next">{p ? "Continue" : "Up next"}</span>}
                  </div>
                  {v.overview && <div className="tp-ep-overview">{v.overview}</div>}
                </div>
              </button>
              {p && (
                <button
                  className={`tp-ep-check ${p.watched ? "on" : ""}`}
                  onClick={() => markWatched(p.key, !p.watched)}
                  title={p.watched ? "Watched. Click to mark unwatched" : "Mark watched"}
                  aria-label={p.watched ? `Mark episode ${v.episode} unwatched` : `Mark episode ${v.episode} watched`}
                  aria-pressed={p.watched}
                >
                  <Check size={15} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function CastAndCrew({ cast, director, writer }: { cast?: string[]; director?: string[]; writer?: string[] }) {
  const { navigate } = useApp();
  const people = [
    ...(cast ?? []).slice(0, 12).map((n) => ({ name: n, role: "Cast" })),
    ...(director ?? []).slice(0, 2).map((n) => ({ name: n, role: "Director" })),
    ...(writer ?? []).slice(0, 2).map((n) => ({ name: n, role: "Writer" })),
  ].filter((p) => typeof p.name === "string" && p.name.trim());
  if (!people.length) return null;
  return (
    <section className="tp-section" aria-label="Cast and crew">
      <div className="tp-section-head"><h2>Cast &amp; crew</h2></div>
      <div className="tp-cast">
        {people.map((p, i) => (
          <button key={`${p.role}:${p.name}`} className="tp-person" onClick={() => navigate({ name: "search", query: p.name })} title={`Search for ${p.name}`}>
            <span className="tp-avatar" style={{ "--h": `${(i * 47) % 360}` } as CSSProperties}>{initials(p.name)}</span>
            <span className="tp-person-name">{p.name}</span>
            <span className="tp-person-role">{p.role}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function About({ meta, awards, released }: { meta: Meta; awards?: string; released?: string }) {
  const rows: [string, string][] = [];
  if (released && !Number.isNaN(Date.parse(released))) rows.push(["Released", new Date(released).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })]);
  if (meta.country) rows.push(["Country", meta.country]);
  if (meta.genres?.length) rows.push(["Genres", meta.genres.join(", ")]);
  if (typeof awards === "string" && awards.trim()) rows.push(["Awards", awards]);
  if (!rows.length) return null;
  return (
    <section className="tp-section" aria-label="About">
      <div className="tp-section-head"><h2>About</h2></div>
      <dl className="tp-about">
        {rows.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </section>
  );
}

const QUALITY_ORDER: QualityGroup[] = ["2160", "1080", "720", "sd", "other"];

export type SourcesMode = "play" | "download";

function SourcesPanel({ meta, video, mode = "play", onClose }: { meta: Meta; video: Video | null; mode?: SourcesMode; onClose: () => void }) {
  const { addons } = useAddons();
  const { navigate, settings, update, toast } = useApp();
  const start = useStartPlayback();
  const [streams, setStreams] = useState<RankedStream[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [providers, setProviders] = useState(0);
  const [quality, setQuality] = useState<QualityGroup | "all">("all");
  const [results, setResults] = useState<Awaited<ReturnType<typeof getStreams>> | null>(null);
  const caps = useCaps();
  const { qualityLimit, hwdec } = settings.playback;

  useEffect(() => {
    let live = true;
    getStreams(addons, meta.type, video?.id ?? meta.id).then((r) => {
      if (!live) return;
      setProviders(r.length);
      setErrors(r.filter((x) => x.error).map((x) => `${x.addon.manifest.name}: ${x.error}`));
      setResults(r);
    });
    return () => {
      live = false;
    };
  }, [addons, meta.type, meta.id, video?.id]);
  // Re-ranked when the device caps arrive or the quality limit changes, without refetching.
  useEffect(() => {
    if (!results) return;
    const ranked = rankStreams(results, rankCapsFor(caps, qualityLimit, hwdec));
    // Hundreds of source rows can arrive at once; render them as a transition.
    startTransition(() => setStreams(ranked));
  }, [results, caps, qualityLimit, hwdec]);
  const deviceAware = !!caps || qualityLimit !== "auto";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const sheet = useRef<HTMLElement>(null);
  useEffect(() => (sheet.current ? trapDialogFocus(sheet.current) : undefined), []);

  const resume = settings.playback.resume;
  const play = useCallback((rs: RankedStream) => start(buildPlayRequest(meta, rs, video, resume)), [start, meta, video, resume]);
  const external = settings.library.downloadExternally;
  const downloadDir = settings.library.downloadDir;
  const setExternal = (v: boolean) => update((s) => ({ ...s, library: { ...s.library, downloadExternally: v } }));
  const download = useCallback(
    (rs: RankedStream) => {
      const url = rs.stream.url;
      if (!url || !/^https?:\/\//i.test(url)) return;
      if (external) {
        // Copied as well, for download managers that take a pasted link.
        void navigator.clipboard?.writeText(url).catch(() => {});
        openUrl(url)
          .then(() => toast("Opened outside Kinly. The link is also copied to your clipboard."))
          .catch((e) => toast(`Couldn't open your browser: ${errorMessage(e)}`, "error"));
        return;
      }
      downloadStart(url, downloadName(meta, rs, video), {
        headers: rs.stream.behaviorHints?.proxyHeaders?.request,
        dir: downloadDir,
        info: { title: meta.name, metaId: meta.id, type: meta.type, season: video?.season, episode: video?.episode },
      })
        .then((p) => toast(`Downloading ${p.name}. Follow it on the Downloads page.`))
        .catch((e) => toast(`Couldn't download: ${errorMessage(e)}`, "error"));
    },
    [toast, external, meta, video, downloadDir],
  );
  const counts = useMemo(() => {
    const c = new Map<QualityGroup, number>();
    for (const s of streams ?? []) c.set(qualityGroup(s.resolution), (c.get(qualityGroup(s.resolution)) ?? 0) + 1);
    return c;
  }, [streams]);
  // Keyed by rank position in the full list, so switching the quality filter keeps the rows.
  const shown = useMemo(
    () => (streams ?? []).map((s, rank) => ({ s, rank })).filter(({ s }) => quality === "all" || qualityGroup(s.resolution) === quality),
    [streams, quality],
  );
  const hasStreamAddon = addons.some((a) => a.manifest.resources.some((r) => (typeof r === "string" ? r : r.name) === "stream"));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside ref={sheet} className="sheet" role="dialog" aria-modal="true" aria-label="Sources" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div style={{ minWidth: 0 }}>
            <div className="sheet-kicker">{mode === "download" ? "Download a source" : "Choose a source"}</div>
            <div className="sheet-title">{meta.name}</div>
            {video && <div className="faint">S{video.season} · E{video.episode}{video.title ?? video.name ? ` · ${video.title ?? video.name}` : ""}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        {!streams ? (
          <Loading label="Finding sources…" />
        ) : (
          <>
            {mode === "download" && streams.length > 0 && (
              <div className="download-where">
                <div className="segmented" role="radiogroup" aria-label="Where to download">
                  <button role="radio" aria-checked={!external} className={external ? "" : "active"} onClick={() => setExternal(false)}>In Kinly</button>
                  <button role="radio" aria-checked={external} className={external ? "active" : ""} onClick={() => setExternal(true)}>Outside Kinly</button>
                </div>
                <p className="faint sheet-note">
                  {external
                    ? <>The link opens in your browser and is copied, so your download manager can take it <PrismHint />.</>
                    : "Kinly saves the video to your download folder (Settings → Library). Follow its progress on the Downloads page."}{" "}
                  Sources without a direct link can only be streamed.
                </p>
              </div>
            )}
            {streams.length > 0 && (
              <div className="chips quality-chips">
                <button className={`chip ${quality === "all" ? "active" : ""}`} onClick={() => setQuality("all")}>All <span>{streams.length}</span></button>
                {QUALITY_ORDER.filter((q) => counts.get(q)).map((q) => (
                  <button key={q} className={`chip ${quality === q ? "active" : ""}`} onClick={() => setQuality(q)}>{QUALITY_LABEL[q]} <span>{counts.get(q)}</span></button>
                ))}
              </div>
            )}
            <div className="sheet-list">
              {providers === 0 &&
                (hasStreamAddon ? (
                  <Empty title={`None of your addons offer ${meta.type === "series" ? "series" : "movies"} like this`}>Add another stream addon on the Addons page.</Empty>
                ) : (
                  <Empty title="No stream addons installed">
                    Install a stream addon on the Addons page. Kinly does not host or provide any content.
                    <button className="btn" onClick={() => navigate({ name: "addons" })}>Open Addons</button>
                  </Empty>
                ))}
              {providers > 0 && streams.length === 0 && <Empty title="No sources found for this title" />}
              {shown.map(({ s, rank }) => (
                <SourceRow key={rank} s={s} best={quality === "all" && rank === 0 && s.playable} deviceAware={deviceAware} mode={mode} onPlay={play} onDownload={download} />
              ))}
            </div>
            {errors.length > 0 && <p className="faint" style={{ fontSize: 12, padding: "0 20px" }}>Some addons failed: {errors.join("; ")}</p>}
          </>
        )}
      </aside>
    </div>
  );
}

const TAG_ICON: Record<string, typeof Disc3> = {
  remux: Disc3, bluray: Disc3, webdl: Globe, webrip: Globe, hdtv: Tv, cam: VideoIcon,
  av1: Cpu, hevc: Cpu, avc: Cpu, dv: Sparkles, hdr10p: SunMedium, hdr: SunMedium,
  atmos: AudioLines, truehd: AudioLines, dts: AudioLines, ddp: AudioLines, ch71: AudioLines, ch51: AudioLines,
};

export function TagBadge({ tag }: { tag: StreamTag }) {
  const Icon = TAG_ICON[tag.id] ?? Cpu;
  return <span className={`tag tag-${tag.kind} tag-${tag.id}`}><Icon size={12} /> {tag.label}</span>;
}

const SourceRow = memo(function SourceRow({ s, best, deviceAware, mode, onPlay, onDownload }: {
  s: RankedStream; best: boolean; deviceAware: boolean; mode: SourcesMode; onPlay: (s: RankedStream) => void; onDownload: (s: RankedStream) => void;
}) {
  const q = qualityGroup(s.resolution);
  const downloadable = s.playable && !!s.stream.url && /^https?:\/\//i.test(s.stream.url);
  const dl = mode === "download";
  const row = (
    <button
      className={`source ${best ? "best" : ""} ${downloadable && !dl ? "has-download" : ""}`}
      disabled={dl ? !downloadable : !s.playable}
      onClick={() => (dl ? onDownload(s) : onPlay(s))}
      title={dl && !downloadable ? "This source has no direct link to download" : s.why ?? s.detail}
    >
      <div className={`q-badge q-${q}`}>{QUALITY_LABEL[q]}</div>
      <div className="source-main">
        <div className="source-title">
          <span className="source-name">{s.label}</span>
          {best && <span className="best-pill">{deviceAware ? "Best match for this device" : "Best match"}</span>}
          {s.stutter && <span className="stutter-pill" title={s.stutter}><AlertTriangle size={11} /> May stutter on this device</span>}
        </div>
        <div className="source-detail">{s.playable ? s.detail || s.addonName : s.why}</div>
        <div className="source-tags">
          {s.tags.map((t) => <TagBadge key={t.id} tag={t} />)}
          {s.sizeBytes ? <span className="tag"><HardDrive size={12} /> {formatBytes(s.sizeBytes)}</span> : null}
          <span className="tag tag-addon">{s.addonName}</span>
        </div>
      </div>
      {dl ? downloadable && <span className="source-play"><Download size={18} /></span> : s.playable && <span className="source-play"><Play size={18} fill="currentColor" /></span>}
    </button>
  );
  if (!downloadable || dl) return row;
  return (
    <div className="source-wrap">
      {row}
      <button className="source-download" onClick={() => onDownload(s)} title="Download this source" aria-label={`Download ${s.label}`}>
        <Download size={16} /> <span>Download</span>
      </button>
    </div>
  );
});

function MoreLikeThis({ meta }: { meta: Meta }) {
  useSyncExternalStore(subscribeCredentials, tmdbKey);
  const key = tmdbKey();
  const { navigate, toast } = useApp();
  const { addons } = useAddons();
  const [recs, setRecs] = useState<(Recommendation & { imdbId?: string | null; imdbRating?: string })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kind = meta.type === "series" ? "series" : "movie";

  useEffect(() => {
    if (!key || !/^tt\d+$/.test(meta.id)) return;
    let live = true;
    setRecs(null);
    setError(null);
    moreLikeThis(meta.id, kind)
      .then(async (list) => {
        if (!live) return;
        setRecs(list);
        // IMDb ids (needed to open a title) and IMDb ratings, a few at a time.
        const queue = [...list];
        const worker = async () => {
          for (let r = queue.shift(); r && live; r = queue.shift()) {
            const rec = r;
            const imdbId = await imdbIdFor(rec).catch(() => null);
            const rating = imdbId ? await getMeta(addons, kind, imdbId).then((m) => m.imdbRating).catch(() => undefined) : undefined;
            if (live) startTransition(() => setRecs((cur) => cur?.map((x) => (x.tmdbId === rec.tmdbId ? { ...x, imdbId, imdbRating: rating } : x)) ?? cur));
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, meta.id, kind]);

  if (!/^tt\d+$/.test(meta.id)) return null;
  if (!key) {
    return (
      <div className="hint-card">
        <Sparkles size={18} /> Connect TMDB to see titles like this one.
        <button className="btn small" onClick={() => navigate({ name: "settings", section: "connections" })}>Connect</button>
      </div>
    );
  }
  if (error) return <p className="faint">More like this: {error}</p>;
  if (recs && recs.length === 0) return null;
  const open = async (r: NonNullable<typeof recs>[number]) => {
    const imdbId = r.imdbId !== undefined ? r.imdbId : await imdbIdFor(r).catch(() => null);
    if (imdbId) navigate({ name: "detail", type: kind, id: imdbId });
    else toast("This title has no IMDb id, so your addons cannot open it", "error");
  };
  return (
    <>
      <div className="section-title">More like this <span className="faint" style={{ fontWeight: 400, fontSize: 13 }}>from TMDB</span></div>
      {!recs ? (
        <Loading />
      ) : (
        <div className="row">
          {recs.map((r) => (
            <button key={r.tmdbId} className="card" onClick={() => void open(r)} title={r.title}>
              <Poster src={r.poster} title={r.title} badge={r.imdbRating ? <ImdbRating value={r.imdbRating} small /> : undefined} />
              <div className="card-title">{r.title}</div>
              <div className="card-sub">{r.year}</div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
