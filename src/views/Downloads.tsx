import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { AlertTriangle, Download, Film, FolderCog, FolderOpen, FolderPlus, Play, RefreshCw, Trash2, X } from "lucide-react";
import { getProgress, progressKey } from "../lib/library";
import { parseRelease } from "../lib/release";
import { formatBytes } from "../lib/streams";
import { DOWNLOAD_SORTS, applyDownloadEvent, downloadSize, downloadTitle, matchesDownload, sortDownloads, type DownloadSort } from "../lib/downloads";
import {
  downloadCancel, downloadDefaultDir, downloadDelete, downloadDirCheck, downloadsList, downloadsManaged, onDownloadFinished, onDownloadProgress,
  type DownloadRecord, type DownloadsListing, type LocalFile,
} from "../lib/tauri";
import { useApp } from "../state";
import { Empty, Loading, Modal, errorMessage } from "../components/ui";
import { useLibraryVersion } from "./Home";
import { useStartPlayback } from "./Detail";
import type { PlayRequest } from "./Player";
import "../styles/library.css";

export const VIDEO_EXTENSIONS = ["mkv", "mp4", "m4v", "avi", "mov", "webm", "ts", "m2ts", "wmv", "mpg", "mpeg"];
const isVideoPath = (p: string) => VIDEO_EXTENSIONS.includes(p.split(".").pop()?.toLowerCase() ?? "");
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dirName = (p: string) => p.slice(0, Math.max(0, p.length - baseName(p).length - 1));

/** Play request for a file on disk. Progress is keyed by path, so resume works from anywhere. */
export function localRequest(f: { path: string; name: string }, resume: boolean): PlayRequest {
  const info = parseRelease(f.name);
  const key = progressKey("local", f.path);
  const prog = getProgress(key);
  const title = info.season != null ? `${info.title} · S${info.season}E${info.episode}` : info.title || f.name;
  return {
    url: f.path,
    title,
    metaId: `local:${info.title.toLowerCase()}`,
    type: "local",
    videoId: f.path,
    season: info.season ?? undefined,
    episode: info.episode ?? undefined,
    filename: f.name,
    year: info.year ?? undefined,
    isLocal: true,
    background: prog?.background,
    startSec: resume && prog && !prog.watched && prog.position > 30 ? prog.position - 3 : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// "Download finished" notifications. One listener per event for the whole app; the most recently
// mounted useDownloadNotifications() shows the toast, so mounting it twice never doubles toasts.
// Browser downloads come from the folder watcher (`downloads:new`), Kinly's own from
// `downloads:progress` when they finish.

type Toast = (text: string, kind?: "error") => void;
const toasters: Toast[] = [];
const refreshers = new Set<() => void>();
let listening: Promise<unknown> | null = null;

function ensureListening() {
  listening ??= Promise.all([
    onDownloadFinished((f) => {
      toasters[toasters.length - 1]?.(`Download finished: ${f.name}`);
      refreshers.forEach((r) => r());
    }),
    onDownloadProgress((r) => {
      if (r.state === "done") toasters[toasters.length - 1]?.(`Download finished: ${downloadTitle(r)}`);
      else if (r.state === "failed") toasters[toasters.length - 1]?.(`Download failed: ${downloadTitle(r)}. ${r.error ?? ""}`.trim(), "error");
    }),
  ]).catch(() => (listening = null));
}

/** Shows download toasts. Mount once near the app root (also mounted by the Downloads page). */
export function useDownloadNotifications() {
  const { toast } = useApp();
  useEffect(() => {
    ensureListening();
    const fn: Toast = (text, kind) => toast(text, kind);
    toasters.push(fn);
    return () => {
      const i = toasters.lastIndexOf(fn);
      if (i >= 0) toasters.splice(i, 1);
    };
  }, [toast]);
}

/** A record with its download speed in bytes/s, smoothed across progress updates. */
type Managed = DownloadRecord & { at: number; rate: number };

/** Every download Kinly made, kept current from `downloads:progress`. */
function useManagedDownloads(): [Managed[] | null, () => void] {
  const [items, setItems] = useState<Managed[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    downloadsManaged()
      .then((list) => live && setItems(list.map((r) => ({ ...r, at: Date.now(), rate: 0 }))))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [nonce]);
  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    onDownloadProgress((r) => {
      setItems((cur) => {
        const list = cur ?? [];
        const prev = list.find((x) => x.id === r.id);
        const at = Date.now();
        let rate = prev?.rate ?? 0;
        if (r.state === "running" && prev && at > prev.at && r.received > prev.received) {
          const instant = ((r.received - prev.received) * 1000) / (at - prev.at);
          rate = rate ? rate * 0.7 + instant * 0.3 : instant;
        }
        const merged = applyDownloadEvent(list, r) as Managed[];
        return merged.map((x) => (x.id === r.id ? { ...r, at, rate } : x));
      });
    })
      .then((u) => (live ? (unlisten = u) : u()))
      .catch(() => {});
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);
  return [items, reload];
}

const ago = (sec: number) => {
  const d = Date.now() / 1000 - sec;
  if (d < 90) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)} d ago`;
  return new Date(sec * 1000).toLocaleDateString();
};

/**
 * Where Kinly saves downloads: shows the folder and changes it through the system folder picker.
 * Only future downloads go to a new folder; earlier ones stay where they are and stay listed.
 */
export function DownloadFolderSetting({ compact = false }: { compact?: boolean }) {
  const { settings, update, toast } = useApp();
  const chosen = settings.library.downloadDir;
  const [fallback, setFallback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void downloadDefaultDir().then(setFallback).catch(() => setFallback(null)), []);
  const setDir = (dir: string | null) => update((s) => ({ ...s, library: { ...s.library, downloadDir: dir } }));
  const change = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Choose where Kinly saves downloads", defaultPath: chosen ?? fallback ?? undefined });
    if (typeof dir !== "string") return;
    setBusy(true);
    try {
      setDir(await downloadDirCheck(dir));
      toast("New downloads will be saved there. Earlier downloads stay where they are.");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const shown = chosen ?? fallback;
  return (
    <div className={`download-folder ${compact ? "compact" : ""}`}>
      <FolderCog size={18} className="faint" />
      <span className="download-folder-text">
        Saving to <code title={shown ?? undefined}>{shown ?? "your Videos folder"}</code>
        {!chosen && <span className="faint"> (default)</span>}
      </span>
      <button className="btn small" onClick={() => void change()} disabled={busy}>{busy ? "Checking…" : "Change…"}</button>
      {chosen && <button className="btn small ghost" onClick={() => setDir(null)}>Use default</button>}
    </div>
  );
}

export default function Downloads() {
  const { settings, update, toast } = useApp();
  const start = useStartPlayback();
  useLibraryVersion();
  useDownloadNotifications();
  const folders = settings.library.folders;
  const [listing, setListing] = useState<DownloadsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<DownloadSort>("date");
  const [nonce, setNonce] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [confirm, setConfirm] = useState<DownloadRecord | null>(null);
  const [managed, reloadManaged] = useManagedDownloads();
  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
    reloadManaged();
  }, [reloadManaged]);

  useEffect(() => {
    let live = true;
    setError(null);
    downloadsList(folders)
      .then((l) => live && setListing(l))
      .catch((e) => {
        if (!live) return;
        setError(errorMessage(e));
        setListing({ dir: null, downloads: [], folders: [] });
      });
    return () => {
      live = false;
    };
  }, [folders, nonce]);

  useEffect(() => {
    refreshers.add(refresh);
    return () => void refreshers.delete(refresh);
  }, [refresh]);

  const play = useCallback(
    (path: string) => start(localRequest({ path, name: baseName(path) }, settings.playback.resume)),
    [start, settings.playback.resume],
  );

  // Drag a video from the file manager onto the page to play it.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let live = true;
    try {
      getCurrentWebview()
        .onDragDropEvent((e) => {
          const p = e.payload;
          if (p.type === "enter" || p.type === "over") setDragging(true);
          else if (p.type === "leave") setDragging(false);
          else if (p.type === "drop") {
            setDragging(false);
            const video = p.paths.find(isVideoPath);
            if (video) play(video);
            else if (p.paths.length) toast("That is not a video file Kinly can play", "error");
          }
        })
        .then((u) => (live ? (unlisten = u) : u()))
        .catch(() => {});
    } catch {
      // Not running inside Tauri (web preview).
    }
    return () => {
      live = false;
      unlisten?.();
    };
  }, [play, toast]);

  const openFile = async () => {
    const path = await open({ multiple: false, title: "Open a video file", filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }] });
    if (typeof path === "string") play(path);
  };
  const addFolder = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Add a folder to Downloads" });
    if (typeof dir === "string" && !folders.includes(dir) && dir !== listing?.dir) update((s) => ({ ...s, library: { ...s.library, folders: [...s.library.folders, dir] } }));
  };
  const removeFolder = (dir: string) => update((s) => ({ ...s, library: { ...s.library, folders: s.library.folders.filter((f) => f !== dir) } }));

  const deleteDownload = async (r: DownloadRecord) => {
    setConfirm(null);
    try {
      await downloadDelete(r.id);
      toast(r.state === "missing" ? `Removed ${downloadTitle(r)} from the list` : `Deleted ${downloadTitle(r)}`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
    refresh();
  };

  const dismiss = useCallback(
    (r: DownloadRecord) => void downloadCancel(r.id).catch(() => {}).then(refresh),
    [refresh],
  );

  const running = useMemo(() => (managed ?? []).filter((r) => r.state === "running"), [managed]);
  const finished = useMemo(
    () => sortDownloads((managed ?? []).filter((r) => r.state !== "running" && matchesDownload(r, filter)), sort) as Managed[],
    [managed, filter, sort],
  );
  // Files Kinly downloaded are listed (and managed) above, not again under the folder they are in.
  // Keyed on the paths alone: progress events (every 400 ms per download) must not re-filter and
  // re-render every local file below.
  const pathsKey = (managed ?? []).map((r) => r.path.toLowerCase()).join("\n");
  const managedPaths = useMemo(() => new Set(pathsKey ? pathsKey.split("\n") : []), [pathsKey]);
  const match = useCallback((f: LocalFile) => !filter || f.name.toLowerCase().includes(filter.toLowerCase()), [filter]);
  const sections = useMemo(() => {
    if (!listing) return [];
    const out: { key: string; title: string; dir: string | null; files: LocalFile[]; error: string | null; removable: boolean }[] = [];
    const browser = listing.downloads.filter((f) => match(f) && !managedPaths.has(f.path.toLowerCase()));
    out.push({ key: "downloads", title: "Downloads folder", dir: listing.dir, files: browser, error: null, removable: false });
    for (const f of listing.folders) {
      const files = f.files.filter((x) => match(x) && !managedPaths.has(x.path.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      out.push({ key: f.dir, title: baseName(f.dir) || f.dir, dir: f.dir, files, error: f.error, removable: true });
    }
    return out;
  }, [listing, match, managedPaths]);
  const total = (managed?.length ?? 0) + (listing ? listing.downloads.length + listing.folders.reduce((n, f) => n + f.files.length, 0) : 0);

  return (
    <div className="page downloads-page">
      <h1 className="page-title">Downloads</h1>
      <p className="faint downloads-lede">
        Videos you download in Kinly are listed and managed here. Videos your browser saves to{" "}
        {listing?.dir ? <code>{listing.dir}</code> : "your Downloads folder"} show up too, and you can drop a video file onto this page to play it.
      </p>
      <DownloadFolderSetting />
      <div className="actions downloads-actions">
        <button className="btn primary" onClick={() => void openFile()}><Film size={18} /> Open file…</button>
        <button className="btn" onClick={() => void addFolder()}><FolderPlus size={18} /> Add folder</button>
        <button className="btn ghost" onClick={refresh}><RefreshCw size={16} /> Refresh</button>
        {total > 0 && <input className="input downloads-filter" placeholder="Filter" aria-label="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      </div>
      {error && <p className="error-text">Could not list your downloads: {error}</p>}

      {running.length > 0 && (
        <section className="downloads-section" aria-label="Downloading">
          <div className="section-title downloads-section-title">
            <Download size={18} />
            <span>Downloading</span>
            <span className="faint downloads-count">{running.length}</span>
          </div>
          <div className="item-list">
            {running.map((d) => <ActiveRow key={d.id} d={d} />)}
          </div>
        </section>
      )}

      <section className="downloads-section" aria-label="Downloaded in Kinly">
        <div className="section-title downloads-section-title">
          <Download size={18} />
          <span>Downloaded in Kinly</span>
          <span className="faint downloads-count">{finished.length} item{finished.length === 1 ? "" : "s"}</span>
          {(managed?.length ?? 0) > 1 && (
            <label className="downloads-sort">
              <span className="faint">Sort</span>
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value as DownloadSort)} aria-label="Sort downloads">
                {DOWNLOAD_SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
          )}
        </div>
        {!managed ? (
          <Loading label="Loading downloads…" />
        ) : finished.length === 0 ? (
          <Empty title={filter ? "No matching downloads" : "Nothing downloaded in Kinly yet"}>
            {!filter && "Use Download on a title page and pick a source. It is saved to the folder above and listed here."}
          </Empty>
        ) : (
          <div className="item-list">
            {finished.map((r) => <ManagedRow key={r.id} r={r} onPlay={play} onDelete={setConfirm} onDismiss={dismiss} />)}
          </div>
        )}
      </section>

      {!listing ? (
        <Loading label="Looking for videos…" />
      ) : (
        sections.map((s) =>
          s.key === "downloads" && s.files.length === 0 && !s.error ? null : (
            <section key={s.key} className="downloads-section">
              <div className="section-title downloads-section-title">
                <FolderOpen size={18} />
                <span>{s.title}</span>
                <span className="faint downloads-count">{s.files.length} file{s.files.length === 1 ? "" : "s"}</span>
                {s.dir && s.removable && <span className="faint downloads-path" title={s.dir}>{s.dir}</span>}
                {s.removable && (
                  <button className="icon-btn" onClick={() => removeFolder(s.key)} aria-label={`Stop showing ${s.dir}`} title="Stop showing this folder"><X size={15} /></button>
                )}
              </div>
              {s.error ? (
                <p className="error-text">{s.error}</p>
              ) : s.files.length === 0 ? (
                <p className="faint">No videos in this folder{filter ? " match the filter" : ""}.</p>
              ) : (
                <div className="item-list">
                  {s.files.map((f) => <FileRow key={f.path} f={f} onPlay={play} />)}
                </div>
              )}
            </section>
          ),
        )
      )}
      {confirm && (
        <Modal
          title={confirm.state === "missing" ? "Remove from the list?" : "Delete this download?"}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn danger-solid" onClick={() => void deleteDownload(confirm)}>
                <Trash2 size={16} /> {confirm.state === "missing" ? "Remove" : "Delete file"}
              </button>
            </>
          }
        >
          {confirm.state === "missing" ? (
            <p><b>{downloadTitle(confirm)}</b> is no longer at <code>{confirm.path}</code>. Kinly will stop listing it.</p>
          ) : (
            <p>
              <b>{downloadTitle(confirm)}</b> ({formatBytes(downloadSize(confirm)) || "unknown size"}) will be deleted from <code>{dirName(confirm.path)}</code>. This can't be undone.
            </p>
          )}
        </Modal>
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div><Film size={40} /><span>Drop a video to play it</span></div>
        </div>
      )}
    </div>
  );
}

function ActiveRow({ d }: { d: Managed }) {
  const pct = d.total > 0 ? Math.min(100, (d.received / d.total) * 100) : null;
  const detail = [
    d.total ? `${formatBytes(d.received) || "0 MB"} of ${formatBytes(d.total)}` : formatBytes(d.received) || "Starting…",
    pct != null ? `${Math.floor(pct)}%` : "",
    d.rate > 0 ? `${formatBytes(d.rate) || "<1 MB"}/s` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="item download-active">
      <div className="item-icon"><Download size={22} /></div>
      <div className="item-main">
        <div className="item-title">{downloadTitle(d)}</div>
        <div className="item-sub">{detail}</div>
        <div className={`download-bar ${pct == null ? "indeterminate" : ""}`} role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100} aria-label={`Downloading ${downloadTitle(d)}`}>
          <i style={pct != null ? { width: `${pct}%` } : undefined} />
        </div>
      </div>
      <div className="item-actions">
        <button className="icon-btn" onClick={() => void downloadCancel(d.id)} aria-label={`Cancel ${downloadTitle(d)}`} title="Cancel download">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

const STATE_BADGE: Record<string, { label: string; cls: string } | undefined> = {
  failed: { label: "Failed", cls: "danger" },
  interrupted: { label: "Interrupted", cls: "danger" },
  missing: { label: "File missing", cls: "" },
};

const ManagedRow = memo(function ManagedRow({ r, onPlay, onDelete, onDismiss }: {
  r: Managed; onPlay: (path: string) => void; onDelete: (r: DownloadRecord) => void; onDismiss: (r: DownloadRecord) => void;
}) {
  const playable = r.state === "done";
  const badge = STATE_BADGE[r.state];
  const p = playable ? getProgress(progressKey("local", r.path)) : null;
  const sub = r.state === "failed" || r.state === "interrupted" ? r.error ?? "" : [r.name !== downloadTitle(r) ? r.name : "", ago(r.finished ?? r.created)].filter(Boolean).join(" · ");
  const main = (
    <>
      <div className="item-icon">{badge?.cls === "danger" ? <AlertTriangle size={22} /> : <Film size={22} />}</div>
      <div className="item-main">
        <div className="item-title">{downloadTitle(r)}</div>
        <div className={`item-sub ${badge?.cls === "danger" ? "error-text" : ""}`} title={r.path}>{sub}</div>
      </div>
    </>
  );
  return (
    <div className="item managed-item">
      {playable ? (
        <button className="managed-play" onClick={() => onPlay(r.path)} title={`Play ${r.path}`}>{main}</button>
      ) : (
        <div className="managed-play static">{main}</div>
      )}
      <div className="item-actions">
        {badge && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
        {p && <span className={`badge ${p.watched ? "ok" : "accent"}`}>{p.watched ? "Watched" : `${Math.round((p.position / Math.max(1, p.duration)) * 100)}%`}</span>}
        {downloadSize(r) > 0 && playable && <span className="badge">{formatBytes(downloadSize(r))}</span>}
        {playable && (
          <button className="icon-btn" onClick={() => onPlay(r.path)} aria-label={`Play ${downloadTitle(r)}`} title="Play"><Play size={16} fill="currentColor" /></button>
        )}
        {r.state === "failed" || r.state === "interrupted" ? (
          <button className="icon-btn" onClick={() => onDismiss(r)} aria-label={`Dismiss ${downloadTitle(r)}`} title="Dismiss"><X size={16} /></button>
        ) : (
          <button className="icon-btn danger" onClick={() => onDelete(r)} aria-label={`Delete ${downloadTitle(r)}`} title={r.state === "missing" ? "Remove from the list" : "Delete"}>
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </div>
  );
});

const FileRow = memo(function FileRow({ f, onPlay }: { f: LocalFile; onPlay: (path: string) => void }) {
  const p = getProgress(progressKey("local", f.path));
  return (
    <button className="item file-item" onClick={() => onPlay(f.path)} title={f.path}>
      <div className="item-icon"><Film size={22} /></div>
      <div className="item-main">
        <div className="item-title">{f.name}</div>
        <div className="item-sub">{f.modified ? ago(f.modified) : ""}</div>
      </div>
      <div className="item-actions">
        {p && <span className={`badge ${p.watched ? "ok" : "accent"}`}>{p.watched ? "Watched" : `${Math.round((p.position / Math.max(1, p.duration)) * 100)}%`}</span>}
        <span className="badge">{formatBytes(f.size)}</span>
        <span className="source-play"><Play size={16} fill="currentColor" /></span>
      </div>
    </button>
  );
});
