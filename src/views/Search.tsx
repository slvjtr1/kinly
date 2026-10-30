import { startTransition, useEffect, useRef, useState } from "react";
import { Search as SearchIcon } from "lucide-react";
import { searchAll, type CatalogDef, type MetaPreview, type Addon } from "../lib/addons";
import { useAddons } from "../lib/useAddons";
import { Empty, GridSkeleton, MetaCard, useOpenMeta } from "../components/ui";

type Group = { addon: Addon; catalog: CatalogDef; items: MetaPreview[] };

export default function Search({ initial }: { initial: string }) {
  const { addons } = useAddons();
  const open = useOpenMeta();
  const [query, setQuery] = useState(initial);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      // Drop any search still in flight, or its "busy" state would stick.
      seq.current++;
      setGroups(null);
      setBusy(false);
      return;
    }
    const mine = ++seq.current;
    const t = window.setTimeout(async () => {
      setBusy(true);
      // A failing addon must not leave the skeleton up for good.
      const r = await searchAll(addons, q).catch(() => [] as Group[]);
      if (mine === seq.current) {
        // Typed once here, so the memoised cards get stable props on later renders.
        const typed = r.map((g) => ({ ...g, items: g.items.slice(0, 24).map((m) => (m.type ? m : { ...m, type: g.catalog.type })) }));
        startTransition(() => {
          setGroups(typed);
          setBusy(false);
        });
      }
    }, 350);
    return () => window.clearTimeout(t);
  }, [query, addons]);

  return (
    <div className="page">
      <div style={{ position: "relative", maxWidth: 640, marginBottom: 26 }}>
        <SearchIcon size={18} style={{ position: "absolute", left: 14, top: 13 }} className="faint" />
        <input
          ref={input}
          className="input"
          style={{ width: "100%", height: 44, paddingLeft: 42, fontSize: 15 }}
          placeholder="Search movies and series"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search"
        />
      </div>
      {busy && !groups && <GridSkeleton count={8} />}
      {groups && groups.length === 0 && !busy && <Empty title={`No results for “${query.trim()}”`}>Try a different spelling or the original title.</Empty>}
      {!groups && !busy && <Empty title="Search across your sources">Type at least two characters.</Empty>}
      {groups?.map((g) => (
        <div key={`${g.addon.transportUrl}:${g.catalog.type}:${g.catalog.id}`}>
          <div className="section-title">
            {g.catalog.type === "movie" ? "Movies" : g.catalog.type === "series" ? "Series" : g.catalog.type}
            <span className="faint" style={{ fontWeight: 400, fontSize: 13 }}>{g.addon.manifest.name}</span>
          </div>
          <div className="grid">
            {g.items.map((m) => (
              <MetaCard key={m.id} meta={m} onOpen={open} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
