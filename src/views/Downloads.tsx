import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { AlertTriangle, Download, Film, FolderOpen, FolderPlus, Play, RefreshCw, X } from "lucide-react";
import { getProgress, progressKey } from "../lib/library";
import { parseRelease } from "../lib/release";
import { formatBytes } from "../lib/streams";
import {
  downloadCancel, downloadsActive, downloadsList, onDownloadFinished, onDownloadProgress, type DownloadProgress, type DownloadsListing, type LocalFile,
} from "../lib/tauri";
import { useApp } from "../state";
import { Empty, Loading, errorMessage } from "../components/ui";
import { useLibraryVersion } from "./Home";
import { useStartPlayback } from "./Detail";
import type { PlayRequest } from "./Player";
import "../styles/library.css";

export const VIDEO_EXTENSIONS = ["mkv", "mp4", "m4v", "avi", "mov", "webm", "ts", "m2ts", "wmv", "mpg", "mpeg"];
const isVideoPath = (p: string) => VIDEO_EXTENSIONS.includes(p.split(".").pop()?.toLowerCase() ?? "");
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

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
// "Download finished" notifications. One Tauri listener for the whole app; the most recently
// mounted useDownloadNotifications() shows the toast, so mounting it twice never doubles toasts.

const toasters: ((f: LocalFile) => void)[] = [];
const refreshers = new Set<() => void>();
let listening: Promise<unknown> | null = null;

function ensureListening() {
  listening ??= onDownloadFinished((f) => {
    toasters[toasters.length - 1]?.(f);
    refreshers.forEach((r) => r());
  }).catch(() => (listening = null));
}

/** Shows "Download finished: <name>" toasts. Mount once near the app root (also mounted by the Downloads page). */
export function useDownloadNotifications() {
  const { toast } = useApp();
  useEffect(() => {
    ensureListening();
    const fn = (f: LocalFile) => toast(`Download finished: ${f.name}`);
    toasters.push(fn);
    return () => {
      const i = toasters.lastIndexOf(fn);
      if (i >= 0) toasters.splice(i, 1);
    };
  }, [toast]);
}

/** A download with its speed in bytes/s, smoothed across progress updates. */
type ActiveDownload = DownloadProgress & { at: number; rate: number };

/** In-app downloads that are running or failed, kept current from `downloads:progress`. */
function useActiveDownloads(onDone: () => void): ActiveDownload[] {
  const [items, setItems] = useState<ActiveDownload[]>([]);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    onDownloadProgress((p) => {
      if (p.state === "done") done.current();
      setItems((cur) => {
        const rest = cur.filter((x) => x.id !== p.id);
        if (p.state !== "running" && p.state !== "failed") return rest;
        const prev = cur.find((x) => x.id === p.id);
        const at = Date.now();
        let rate = prev?.rate ?? 0;
        if (prev && at > prev.at && p.received > prev.received) {
          const instant = ((p.received - prev.received) * 1000) / (at - prev.at);
          rate = rate ? rate * 0.7 + instant * 0.3 : instant;
        }
        return [...rest, { ...p, at, rate }].sort((a, b) => a.id - b.id);
      });
    })
      .then((u) => (live ? (unlisten = u) : u()))
      .catch(() => {});
    downloadsActive()
      .then((a) => live && setItems((cur) => (cur.length ? cur : a.map((p) => ({ ...p, at: Date.now(), rate: 0 })))))
      .catch(() => {});
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);
  return items;
}

const ago = (sec: number) => {
  const d = Date.now() / 1000 - sec;
  if (d < 90) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)} d ago`;
  return new Date(sec * 1000).toLocaleDateString();
};

export default function Downloads() {
  const { settings, update, toast } = useApp();
  const start = useStartPlayback();
  useLibraryVersion();
  useDownloadNotifications();
  const folders = settings.library.folders;
  const [listing, setListing] = useState<DownloadsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [nonce, setNonce] = useState(0);
  const [dragging, setDragging] = useState(false);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const active = useActiveDownloads(refresh);

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

  const match = useCallback((f: LocalFile) => !filter || f.name.toLowerCase().includes(filter.toLowerCase()), [filter]);
  const sections = useMemo(() => {
    if (!listing) return [];
    const out: { key: string; title: string; dir: string | null; files: LocalFile[]; error: string | null; removable: boolean }[] = [];
    out.push({ key: "downloads", title: "Downloads", dir: listing.dir, files: listing.downloads.filter(match), error: null, removable: false });
    for (const f of listing.folders) {
      const files = f.files.filter(match).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      out.push({ key: f.dir, title: baseName(f.dir) || f.dir, dir: f.dir, files, error: f.error, removable: true });
    }
    return out;
  }, [listing, match]);
  const total = listing ? listing.downloads.length + listing.folders.reduce((n, f) => n + f.files.length, 0) : 0;

  return (
    <div className="page downloads-page">
      <h1 className="page-title">Downloads</h1>
      <p className="faint downloads-lede">
        Videos you download from a source appear here when they finish{listing?.dir ? <> (from <code>{listing.dir}</code>)</> : null}. You can also drop a video file onto this page.
      </p>
      <div className="actions downloads-actions">
        <button className="btn primary" onClick={() => void openFile()}><Film size={18} /> Open file…</button>
        <button className="btn" onClick={() => void addFolder()}><FolderPlus size={18} /> Add folder</button>
        <button className="btn ghost" onClick={refresh}><RefreshCw size={16} /> Refresh</button>
        {total > 0 && <input className="input downloads-filter" placeholder="Filter" aria-label="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      </div>
      {error && <p className="error-text">Could not list your downloads: {error}</p>}

      {active.length > 0 && (
        <section className="downloads-section">
          <div className="section-title downloads-section-title">
            <Download size={18} />
            <span>In progress</span>
            <span className="faint downloads-count">{active.filter((d) => d.state === "running").length} running</span>
          </div>
          <div className="item-list">
            {active.map((d) => <ActiveRow key={d.id} d={d} />)}
          </div>
        </section>
      )}

      {!listing ? (
        <Loading label="Looking for videos…" />
      ) : (
        sections.map((s) => (
          <section key={s.key} className="downloads-section">
            <div className="section-title downloads-section-title">
              {s.key === "downloads" ? <Download size={18} /> : <FolderOpen size={18} />}
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
              s.key === "downloads" ? (
                <Empty title={filter ? "No matching downloads" : listing.dir ? "No finished video downloads yet" : "No download folder found"}>
                  {!filter && "Use Download on a source in a title's source list. It shows up here once it is complete."}
                </Empty>
              ) : (
                <p className="faint">No videos in this folder{filter ? " match the filter" : ""}.</p>
              )
            ) : (
              <div className="item-list">
                {s.files.map((f) => <FileRow key={f.path} f={f} onPlay={play} />)}
              </div>
            )}
          </section>
        ))
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div><Film size={40} /><span>Drop a video to play it</span></div>
        </div>
      )}
    </div>
  );
}

function ActiveRow({ d }: { d: ActiveDownload }) {
  const failed = d.state === "failed";
  const pct = d.total > 0 ? Math.min(100, (d.received / d.total) * 100) : null;
  const rate = d.state === "running" ? d.rate : 0;
  const detail = failed
    ? d.error ?? "Download failed"
    : [d.total ? `${formatBytes(d.received) || "0 MB"} of ${formatBytes(d.total)}` : formatBytes(d.received) || "Starting…", pct != null ? `${Math.floor(pct)}%` : "", rate > 0 ? `${formatBytes(rate) || "<1 MB"}/s` : ""]
        .filter(Boolean)
        .join(" · ");
  return (
    <div className="item download-active">
      <div className="item-icon">{failed ? <AlertTriangle size={22} /> : <Download size={22} />}</div>
      <div className="item-main">
        <div className="item-title">{d.name}</div>
        <div className={`item-sub ${failed ? "error-text" : ""}`}>{detail}</div>
        {!failed && (
          <div className={`download-bar ${pct == null ? "indeterminate" : ""}`} role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100} aria-label={`Downloading ${d.name}`}>
            <i style={pct != null ? { width: `${pct}%` } : undefined} />
          </div>
        )}
      </div>
      <div className="item-actions">
        <button className="icon-btn" onClick={() => void downloadCancel(d.id)} aria-label={failed ? `Dismiss ${d.name}` : `Cancel ${d.name}`} title={failed ? "Dismiss" : "Cancel download"}>
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

function FileRow({ f, onPlay }: { f: LocalFile; onPlay: (path: string) => void }) {
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
}
