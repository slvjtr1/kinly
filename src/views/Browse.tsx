import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { getCatalog, type MetaPreview } from "../lib/addons";
import { useAddons } from "../lib/useAddons";
import { Empty, ErrorState, GridSkeleton, Loading, MetaCard, errorMessage, useOpenMeta } from "../components/ui";

export default function Browse({ type }: { type: "movie" | "series" }) {
  const { addons } = useAddons();
  const open = useOpenMeta(type);
  const catalogs = useMemo(
    () =>
      addons.flatMap((addon) =>
        addon.manifest.catalogs
          .filter((c) => c.type === type && !c.extra?.some((e) => e.isRequired && e.name !== "genre"))
          .map((catalog) => ({ addon, catalog, key: `${addon.transportUrl}|${catalog.id}` })),
      ),
    [addons, type],
  );
  const [catKey, setCatKey] = useState<string | null>(null);
  const [genre, setGenre] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<MetaPreview[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "error" | "end">("idle");
  const [error, setError] = useState("");
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  // Bumped when the catalog or genre changes: a page still loading for the old one is dropped.
  const gen = useRef(0);

  const active = catalogs.find((c) => c.key === catKey) ?? catalogs[0];
  const genres = active?.catalog.extra?.find((e) => e.name === "genre")?.options ?? [];
  const genreRequired = active?.catalog.extra?.some((e) => e.name === "genre" && e.isRequired);
  const effectiveGenre = genre ?? (genreRequired ? genres[0] : undefined);
  const canPage = active?.catalog.extra?.some((e) => e.name === "skip") ?? false;

  const load = async (reset: boolean) => {
    if (!active || (!reset && loadingRef.current)) return;
    const mine = reset ? ++gen.current : gen.current;
    loadingRef.current = true;
    setState("loading");
    try {
      const skip = reset ? 0 : items.length;
      const page = await getCatalog(active.addon, type, active.catalog.id, { genre: effectiveGenre, skip: skip || undefined });
      if (mine !== gen.current) return;
      // A transition: rendering a page of cards yields to scrolling and the spinner.
      startTransition(() => {
        setItems((prev) => {
          const base = reset ? [] : prev;
          const seen = new Set(base.map((m) => m.id));
          return [...base, ...page.filter((m) => !seen.has(m.id))];
        });
        setState(page.length === 0 || !canPage ? "end" : "idle");
      });
    } catch (e) {
      if (mine !== gen.current) return;
      setError(errorMessage(e));
      setState("error");
    } finally {
      if (mine === gen.current) loadingRef.current = false;
    }
  };

  useEffect(() => {
    setItems([]);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.key, effectiveGenre]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && state === "idle" && items.length > 0) void load(false);
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  });

  if (catalogs.length === 0) return <div className="page"><Empty title={`No ${type === "movie" ? "movie" : "series"} catalogs installed`}>Add a catalog addon on the Addons page.</Empty></div>;

  return (
    <div className="page">
      <h1 className="page-title">{type === "movie" ? "Movies" : "Series"}</h1>
      <div className="chips" style={{ marginBottom: 12 }}>
        {catalogs.map((c) => (
          <button key={c.key} className={`chip ${c.key === active?.key ? "active" : ""}`} onClick={() => { setCatKey(c.key); setGenre(undefined); }}>
            {c.catalog.name ?? c.catalog.id}
            {catalogs.some((o) => o !== c && o.catalog.name === c.catalog.name) ? ` · ${c.addon.manifest.name}` : ""}
          </button>
        ))}
      </div>
      {genres.length > 0 && (
        <div className="chips" style={{ marginBottom: 22 }}>
          {!genreRequired && (
            <button className={`chip ${!genre ? "active" : ""}`} onClick={() => setGenre(undefined)}>All</button>
          )}
          {genres.map((g) => (
            <button key={g} className={`chip ${effectiveGenre === g ? "active" : ""}`} onClick={() => setGenre(g)}>{g}</button>
          ))}
        </div>
      )}
      {state === "error" && items.length === 0 ? (
        <ErrorState title="Could not load this catalog" detail={error} onRetry={() => void load(true)} />
      ) : (
        <div className="grid">
          {items.map((m) => (
            <MetaCard key={m.id} meta={m} onOpen={open} />
          ))}
        </div>
      )}
      {state === "loading" && (items.length === 0 ? <GridSkeleton /> : <Loading />)}
      {state === "end" && items.length === 0 && <Empty title="Nothing here" />}
      <div ref={sentinel} style={{ height: 1 }} />
    </div>
  );
}
