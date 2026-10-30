import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Clapperboard, Info, Play } from "lucide-react";
import { getCatalog, type Addon, type CatalogDef, type MetaPreview } from "../lib/addons";
import { continueWatching, getLibrary, subscribeLibrary, type Progress } from "../lib/library";
import { trailersOf, type Trailer } from "../lib/trailers";
import { useAddons } from "../lib/useAddons";
import { useApp } from "../state";
import { ErrorState, ImdbRating, MetaCard, RowSkeleton, WideCard, useOpenMeta } from "../components/ui";
import { localRequest } from "./Downloads";
import TrailerPlayer from "./TrailerPlayer";
import { TitleArt, hideBroken } from "./Detail";
import "../styles/library.css";
import "../styles/home.css";

const TYPE_LABEL: Record<string, string> = { movie: "Movies", series: "Series" };
/** Hero slides: the top titles with artwork from the first two catalogs (movies and series). */
const HERO_SLIDES = 6;
const HERO_SOURCES = 2;
/** Time each slide stays up, and the slide transition (keep in sync with home.css). */
export const HERO_INTERVAL = 5000;
const SLIDE_MS = 720;

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;
const reducedMotion = () =>
  document.documentElement.dataset.reduceMotion === "true" || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);

export function homeCatalogs(addons: Addon[]): { addon: Addon; catalog: CatalogDef }[] {
  const out: { addon: Addon; catalog: CatalogDef }[] = [];
  for (const addon of addons)
    for (const catalog of addon.manifest.catalogs)
      if ((catalog.type === "movie" || catalog.type === "series") && !catalog.extra?.some((e) => e.isRequired)) out.push({ addon, catalog });
  return out.slice(0, 8);
}

/** Interleaves the catalogs' items with artwork (logo first), de-duplicated, up to `limit`. */
export function heroSlides(pools: (MetaPreview[] | undefined)[], limit = HERO_SLIDES): MetaPreview[] {
  const usable = pools.map((p) =>
    (p ?? []).filter((m) => m.background && m.description).sort((a, b) => Number(!!b.logo) - Number(!!a.logo)).slice(0, limit),
  );
  const out: MetaPreview[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < limit && usable.some((p) => i < p.length); i++)
    for (const p of usable) {
      const m = p[i];
      if (m && !seen.has(m.id) && out.length < limit) {
        seen.add(m.id);
        out.push(m);
      }
    }
  return out;
}

export function useLibraryVersion() {
  return useSyncExternalStore(subscribeLibrary, getLibrary);
}

export default function Home() {
  const { status, addons, error } = useAddons();
  const lib = useLibraryVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cw = useMemo(() => continueWatching(), [lib]);
  const catalogs = useMemo(() => homeCatalogs(addons), [addons]);
  const [pools, setPools] = useState<(MetaPreview[] | undefined)[]>([]);
  const onItems = useCallback((i: number, items: MetaPreview[]) => setPools((p) => {
    const next = [...p];
    next[i] = items;
    return next;
  }), []);
  // The slides are built once, when the hero catalogs have all answered (or 1.5 s after the
  // first), so the carousel never reshuffles under the viewer.
  const heroSources = Math.min(HERO_SOURCES, catalogs.length);
  const arrived = pools.filter(Boolean).length;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (arrived === 0 || waited) return;
    const t = window.setTimeout(() => setWaited(true), 1500);
    return () => window.clearTimeout(t);
  }, [arrived, waited]);
  const ready = arrived > 0 && (arrived >= heroSources || waited);
  const [slides, setSlides] = useState<MetaPreview[]>([]);
  useEffect(() => {
    if (ready && slides.length === 0) setSlides(heroSlides(pools));
  }, [ready, pools, slides.length]);

  if (status === "error") return <ErrorState title="No content sources available" detail={error} />;

  return (
    <div className="page">
      <HeroCarousel slides={slides} />
      {cw.length > 0 && <ContinueRow items={cw} />}
      {status === "loading" && <RowSkeleton />}
      {catalogs.map(({ addon, catalog }, i) => (
        <CatalogRow
          key={`${addon.transportUrl}:${catalog.type}:${catalog.id}`}
          addon={addon}
          catalog={catalog}
          index={i}
          onItems={i < HERO_SOURCES ? onItems : undefined}
        />
      ))}
    </div>
  );
}

/**
 * The Home hero: a sideways-sliding carousel of the top titles. Advances every HERO_INTERVAL ms,
 * pauses while hovered, focused or hidden; arrows, dots and ←/→ move it. Only transform and
 * opacity animate. A clone of the first slide after the last keeps the loop going forwards.
 */
const HeroCarousel = memo(function HeroCarousel({ slides }: { slides: MetaPreview[] }) {
  const { navigate } = useApp();
  const n = slides.length;
  const [pos, setPos] = useState(0); // 0..n; n is the clone of slide 0
  const [animate, setAnimate] = useState(true);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const [trailer, setTrailer] = useState<{ t: Trailer; m: MetaPreview } | null>(null);
  const [loaded, setLoaded] = useState<Set<number>>(() => new Set());
  const paused = hover || focus || hidden || !!trailer || n < 2;
  const active = n ? pos % n : 0;

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Backdrops mount for the current slide and its neighbours (the next one preloads), and stay.
  useEffect(() => {
    if (!n) return;
    setLoaded((prev) => {
      const want = [active, (active + 1) % n, (active - 1 + n) % n];
      if (want.every((i) => prev.has(i))) return prev;
      const next = new Set(prev);
      want.forEach((i) => next.add(i));
      return next;
    });
  }, [active, n]);

  // After sliding onto the clone, jump back to the real first slide without animating.
  useEffect(() => {
    if (pos !== n || !n) return;
    const t = window.setTimeout(() => {
      setAnimate(false);
      setPos(0);
    }, SLIDE_MS + 40);
    return () => window.clearTimeout(t);
  }, [pos, n]);
  useEffect(() => {
    if (animate) return;
    // Two frames: the jump is painted without a transition before transitions come back.
    let r2 = 0;
    const r1 = requestAnimationFrame(() => (r2 = requestAnimationFrame(() => setAnimate(true))));
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [animate]);

  // The slide itself: the track's transform is written once per frame from
  // requestAnimationFrame, so it runs in every performance mode (performance mode turns CSS
  // transitions off app-wide) and an interrupted slide continues from where it is. The track is
  // its own compositing layer. Note: on WebKitGTK with shared-memory buffers (NVIDIA + X11, see
  // webview.rs) layer transform changes are only presented on the next repaint, so there the
  // slide shows as a clean cut; a non-composited translate tears instead, which looks worse.
  const trackRef = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const write = (x: number) => {
      offset.current = x;
      el.style.transform = `translate3d(${-x * 100}%, 0, 0)`;
    };
    const from = offset.current;
    if (!animate || from === pos || reducedMotion()) return write(pos);
    const ms = document.documentElement.dataset.perf === "performance" ? SLIDE_MS * 0.8 : SLIDE_MS;
    const start = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / ms);
      write(from + (pos - from) * easeOutQuart(t));
      if (t < 1) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [pos, animate]);

  const go = useCallback(
    (to: number) => {
      if (n < 2) return;
      setAnimate(true);
      setPos(to);
    },
    [n],
  );
  const next = useCallback(() => {
    if (n < 2) return;
    if (pos >= n) {
      // Still on the clone: stand on the real first slide, then move on.
      setAnimate(false);
      setPos(0);
      requestAnimationFrame(() => requestAnimationFrame(() => go(1)));
    } else go(pos + 1);
  }, [go, pos, n]);
  const prev = useCallback(() => {
    if (n < 2) return;
    if (pos === 0) {
      // From the first slide: stand on the clone (same picture), then slide back to the last.
      setAnimate(false);
      setPos(n);
      requestAnimationFrame(() => requestAnimationFrame(() => go(n - 1)));
    } else go(pos - 1);
  }, [go, pos, n]);

  // Autoplay; the timer restarts on every slide change and resume.
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    if (paused) return;
    const t = window.setTimeout(next, HERO_INTERVAL);
    return () => window.clearTimeout(t);
  }, [paused, next, cycle]);
  useEffect(() => {
    if (!paused) setCycle((c) => c + 1);
  }, [paused]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowRight") next();
    else if (e.key === "ArrowLeft") prev();
    else return;
    e.preventDefault();
  };

  if (!n) return <div className="hc hero-loading" />;
  const frames = [...slides, slides[0]];
  return (
    <section
      className={`hc ${paused ? "paused" : ""}`}
      aria-roledescription="carousel"
      aria-label="Featured"
      tabIndex={-1}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocus(false)}
      onKeyDown={onKey}
    >
      <div className="hc-track" ref={trackRef}>
        {frames.map((m, i) => {
          const real = i % n;
          return (
            <div key={i} className={`hc-frame ${i === pos ? "current" : ""}`} aria-hidden="true">
              {loaded.has(real) && m.background && (
                <img src={m.background} alt="" decoding="async" fetchPriority={real === 0 ? "high" : "low"} draggable={false} onError={hideBroken} />
              )}
            </div>
          );
        })}
      </div>
      <div className="hc-shade" />
      <div className="hc-texts">
        {slides.map((m, i) => {
          const t = trailersOf(m)[0];
          const on = i === active;
          return (
            <div
              key={m.id}
              className={`hc-content ${on ? "on" : ""}`}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${n}: ${m.name}`}
              aria-hidden={!on}
              inert={!on}
            >
              <div className="hc-kicker">{m.type === "series" ? "Series" : "Movie"} <span>· Top pick</span></div>
              <TitleArt logo={m.logo} name={m.name} imgClass="hc-logo" titleClass="hc-title" />
              <div className="hc-meta">
                <ImdbRating value={m.imdbRating} />
                {m.releaseInfo && <span>{m.releaseInfo}</span>}
                {m.genres?.slice(0, 3).map((g) => <span key={g} className="hc-genre">{g}</span>)}
              </div>
              <p className="hc-desc">{m.description}</p>
              <div className="hc-actions">
                <button className="btn primary large" onClick={() => navigate({ name: "detail", type: m.type, id: m.id })}>
                  <Play size={19} fill="currentColor" /> Watch now
                </button>
                {t && (
                  <button className="btn glass large" onClick={() => setTrailer({ t, m })}>
                    <Clapperboard size={18} /> Trailer
                  </button>
                )}
                <button className="btn glass large" onClick={() => navigate({ name: "detail", type: m.type, id: m.id })}>
                  <Info size={18} /> Details
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {n > 1 && (
        <>
          <button className="hc-arrow prev" onClick={prev} aria-label="Previous title"><ChevronLeft size={26} /></button>
          <button className="hc-arrow next" onClick={next} aria-label="Next title"><ChevronRight size={26} /></button>
          <div className="hc-dots" role="tablist" aria-label="Choose a title">
            {slides.map((m, i) => (
              <button
                key={m.id}
                role="tab"
                aria-selected={i === active}
                aria-label={m.name}
                className={`hc-dot ${i === active ? "on" : ""}`}
                onClick={() => (i === active ? undefined : go(i === 0 && pos === n - 1 ? n : i))}
              >
                {i === active && <i key={`${pos}:${cycle}`} style={{ animationDuration: `${HERO_INTERVAL}ms` }} />}
              </button>
            ))}
          </div>
        </>
      )}
      {trailer && <TrailerPlayer trailer={trailer.t} title={trailer.m.name} backdrop={trailer.m.background} onClose={() => setTrailer(null)} />}
    </section>
  );
});

function ContinueRow({ items }: { items: Progress[] }) {
  const { navigate, settings } = useApp();
  return (
    <>
      <div className="section-title">Continue watching</div>
      <div className="row wide">
        {items.map((p) => (
          <WideCard
            key={p.key}
            image={p.background ?? p.poster}
            title={p.name}
            subtitle={p.season != null ? `S${p.season} · E${p.episode}${p.episodeTitle ? ` · ${p.episodeTitle}` : ""}` : `${Math.round((p.position / p.duration) * 100)}% watched`}
            progress={p.position / p.duration}
            onOpen={() =>
              p.type === "local" && p.source
                ? navigate({ name: "player", req: localRequest({ path: p.source, name: p.source.split(/[\\/]/).pop() ?? p.name }, settings.playback.resume) })
                : navigate({ name: "detail", type: p.type, id: p.metaId })
            }
          />
        ))}
      </div>
    </>
  );
}

// Memoised: Home re-renders on library changes and when hero items arrive; rows only change with their own data.
const CatalogRow = memo(function CatalogRow({ addon, catalog, index, onItems }: {
  addon: Addon; catalog: CatalogDef; index: number; onItems?: (i: number, m: MetaPreview[]) => void;
}) {
  const open = useOpenMeta(catalog.type);
  const [items, setItems] = useState<MetaPreview[] | null>(null);
  const [failed, setFailed] = useState(false);
  const report = useRef(onItems);
  report.current = onItems;
  useEffect(() => {
    let live = true;
    getCatalog(addon, catalog.type, catalog.id)
      .then((m) => {
        if (!live) return;
        // Rows arrive one by one; as transitions their renders yield to input and animation.
        startTransition(() => {
          setItems(m.slice(0, 30));
          report.current?.(index, m.slice(0, 20));
        });
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addon.transportUrl, catalog.type, catalog.id]);

  if (failed || (items && items.length === 0)) return null;
  return (
    <>
      <div className="section-title">
        {catalog.name ?? catalog.id} <span className="faint" style={{ fontWeight: 400, fontSize: 14 }}>{TYPE_LABEL[catalog.type] ?? catalog.type}</span>
      </div>
      {items ? (
        <div className="row">
          {items.map((m) => (
            <MetaCard key={m.id} meta={m} onOpen={open} />
          ))}
        </div>
      ) : (
        <RowSkeleton />
      )}
    </>
  );
});
