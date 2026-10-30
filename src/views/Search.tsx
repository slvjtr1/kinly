import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { History, Search as SearchIcon, Trash2, X } from "lucide-react";
import { searchAll, type CatalogDef, type MetaPreview, type Addon } from "../lib/addons";
import { clearSearches, forgetSearch, rememberSearch, useSearchHistory } from "../lib/searchHistory";
import { useAddons } from "../lib/useAddons";
import { Empty, MetaCard, Modal, RowSkeleton, useOpenMeta } from "../components/ui";

type Group = { addon: Addon; catalog: CatalogDef; items: MetaPreview[] };

export default function Search({ initial }: { initial: string }) {
  const { addons } = useAddons();
  const openMeta = useOpenMeta();
  const history = useSearchHistory();
  const [query, setQuery] = useState(initial);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
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

  // A search is remembered when it is confirmed (Enter) or one of its results is opened, not for
  // every half-typed query.
  const queryRef = useRef(query);
  queryRef.current = query;
  const open = useCallback(
    (m: MetaPreview) => {
      void rememberSearch(queryRef.current);
      openMeta(m);
    },
    [openMeta],
  );
  const searchAgain = (q: string) => {
    setQuery(q);
    void rememberSearch(q);
    input.current?.focus();
  };

  const showHistory = !groups && !busy && query.trim().length < 2;

  return (
    <div className="page">
      <div className="search-box">
        <SearchIcon size={18} className="faint search-box-icon" />
        <input
          ref={input}
          className="input"
          placeholder="Search movies and series"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void rememberSearch(query)}
          aria-label="Search"
        />
        {query && (
          <button className="icon-btn search-box-clear" onClick={() => { setQuery(""); input.current?.focus(); }} aria-label="Clear the search box" title="Clear">
            <X size={16} />
          </button>
        )}
      </div>
      {busy && !groups && <RowSkeleton />}
      {groups && groups.length === 0 && !busy && <Empty title={`No results for “${query.trim()}”`}>Try a different spelling or the original title.</Empty>}
      {showHistory && history.length === 0 && <Empty title="Search across your sources">Type at least two characters. Your recent searches will show up here.</Empty>}
      {showHistory && history.length > 0 && (
        <section className="search-history" aria-label="Recent searches">
          <div className="section-title search-history-title">
            <History size={18} /> Recent searches
            <button className="btn ghost small" onClick={() => setConfirmClear(true)}>
              <Trash2 size={15} /> Clear search history
            </button>
          </div>
          <ul className="search-history-list">
            {history.map((q) => (
              <li key={q} className="search-history-item">
                <button className="search-history-query" onClick={() => searchAgain(q)} title={`Search for “${q}”`}>
                  <SearchIcon size={15} className="faint" /> <span>{q}</span>
                </button>
                <button className="icon-btn" onClick={() => void forgetSearch(q)} aria-label={`Remove “${q}” from search history`} title="Remove">
                  <X size={15} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {groups?.map((g) => (
        <div key={`${g.addon.transportUrl}:${g.catalog.type}:${g.catalog.id}`}>
          <div className="section-title">
            {g.catalog.type === "movie" ? "Movies" : g.catalog.type === "series" ? "Series" : g.catalog.type}
            <span className="faint" style={{ fontWeight: 400, fontSize: 13 }}>{g.addon.manifest.name}</span>
          </div>
          {/* One horizontal row per source, like Home: long result lists scroll sideways instead of stacking into a tall page. */}
          <div className="row">
            {g.items.map((m) => (
              <MetaCard key={m.id} meta={m} onOpen={open} />
            ))}
          </div>
        </div>
      ))}
      {confirmClear && (
        <Modal
          title="Clear search history?"
          onClose={() => setConfirmClear(false)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setConfirmClear(false)}>Cancel</button>
              <button className="btn danger" onClick={() => { void clearSearches(); setConfirmClear(false); }}>Clear history</button>
            </>
          }
        >
          <p>
            This removes {history.length === 1 ? "your recent search" : `all ${history.length} recent searches`} for this profile on this computer. Your watch history and downloads are
            not affected.
          </p>
        </Modal>
      )}
    </div>
  );
}
