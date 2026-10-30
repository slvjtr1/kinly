import { useState } from "react";
import { Check, Trash2, Undo2 } from "lucide-react";
import { clearHistory, getLibrary, history, markWatched, removeProgress } from "../lib/library";
import { useApp } from "../state";
import { Empty, MetaCard, useOpenMeta } from "../components/ui";
import { useLibraryVersion } from "./Home";
import { fmtTime } from "./Player";
import { localRequest } from "./Downloads";
import "../styles/library.css";

export default function Library() {
  useLibraryVersion();
  const { navigate, settings } = useApp();
  const open = useOpenMeta();
  const [tab, setTab] = useState<"watchlist" | "history">("watchlist");
  const [confirm, setConfirm] = useState(false);
  const { watchlist } = getLibrary();
  const hist = history();

  return (
    <div className="page">
      <h1 className="page-title">Library</h1>
      <div className="chips" style={{ marginBottom: 22 }}>
        <button className={`chip ${tab === "watchlist" ? "active" : ""}`} onClick={() => setTab("watchlist")}>Watchlist · {watchlist.length}</button>
        <button className={`chip ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>History · {hist.length}</button>
      </div>

      {tab === "watchlist" &&
        (watchlist.length === 0 ? (
          <Empty title="Your watchlist is empty">Use the Watchlist button on any movie or series page.</Empty>
        ) : (
          <div className="grid">
            {watchlist.map((w) => (
              <MetaCard key={w.id} meta={w} onOpen={open} />
            ))}
          </div>
        ))}

      {tab === "history" &&
        (hist.length === 0 ? (
          <Empty title="Nothing watched yet">Titles you play appear here with your progress.</Empty>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
              {confirm ? (
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="muted">Clear all watch history and progress?</span>
                  <button className="btn danger" onClick={() => { clearHistory(); setConfirm(false); }}>Clear</button>
                  <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
                </span>
              ) : (
                <button className="btn ghost" onClick={() => setConfirm(true)}><Trash2 size={16} /> Clear history</button>
              )}
            </div>
            <div className="panel history-list">
              {hist.map((p) => (
                <div key={p.key} className="history-row">
                  <div className="history-thumb">{p.poster && <img src={p.poster} alt="" loading="lazy" decoding="async" />}</div>
                  <button
                    className="history-open"
                    onClick={() =>
                      p.type === "local" && p.source
                        ? navigate({ name: "player", req: localRequest({ path: p.source, name: p.source.split(/[\\/]/).pop() ?? p.name }, settings.playback.resume) })
                        : navigate({ name: "detail", type: p.type, id: p.metaId })
                    }
                  >
                    <div className="history-title">{p.name}{p.season != null ? ` · S${p.season}E${p.episode}` : ""}</div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {p.watched ? "Watched" : `${fmtTime(p.position)} of ${fmtTime(p.duration)}`} · {new Date(p.updatedAt).toLocaleString()}
                    </div>
                  </button>
                  <div className="item-actions">
                    <button className="icon-btn" title={p.watched ? "Mark unwatched" : "Mark watched"} aria-label={p.watched ? "Mark unwatched" : "Mark watched"} onClick={() => markWatched(p.key, !p.watched)}>
                      {p.watched ? <Undo2 size={16} /> : <Check size={16} />}
                    </button>
                    <button className="icon-btn danger" title="Remove from history" aria-label="Remove from history" onClick={() => removeProgress(p.key)}><Trash2 size={16} /></button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ))}
    </div>
  );
}
