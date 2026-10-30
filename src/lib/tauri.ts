// Typed wrappers around the Rust commands. Nothing else in the UI calls invoke().
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type HttpResponse = { status: number; body: string };

export async function http(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<HttpResponse> {
  return invoke("http_request", { req: { url, ...init } });
}

export async function httpJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  const r = await http(url, { timeoutMs });
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
  try {
    return JSON.parse(r.body) as T;
  } catch {
    throw new Error("Invalid JSON from server");
  }
}

export type StoreName = "settings" | "library" | "addons" | "credentials" | "subprefs" | "account" | "trakt" | "profile" | "searches";
export type LoadResult<T> = { value: T | null; recoveredFrom: string | null };

export const storeLoad = <T>(name: StoreName) => invoke<LoadResult<T>>("store_load", { name });
export const storeSave = (name: StoreName, value: unknown) => invoke<void>("store_save", { name, value });

export type AppInfo = {
  version: string;
  configDir: string;
  dataDir: string;
  cacheDir: string;
  logDir: string;
  fontsDir: string | null;
  ffmpeg: boolean;
  /** A yt-dlp (Kinly's managed copy or one on PATH) is available for trailers. */
  ytdlp: boolean;
  /** Rust's target OS name: "linux", "windows", … */
  os: string;
};
export const appInfo = () => invoke<AppInfo>("app_info");
export const uiLog = (level: "info" | "warn" | "error", message: string) =>
  invoke<void>("ui_log", { level, message }).catch(() => {});

// Player
export const player = {
  load: (url: string, opts: { startSec?: number; title?: string; headers?: Record<string, string> } = {}) =>
    invoke<void>("player_load", { args: { url, ...opts } }),
  command: (...args: (string | number)[]) => invoke<void>("player_command", { args: args.map(String) }),
  set: (name: string, value: string | number | boolean) => invoke<void>("player_set", { name, value }),
  setMany: (props: [string, string | number | boolean][]) => invoke<string[]>("player_set_many", { props }),
  get: <T = unknown>(name: string) => invoke<T>("player_get", { name }),
  subAdd: (path: string, title: string, lang: string, select: boolean) =>
    invoke<{ sid: number }>("player_sub_add", { path, title, lang, select }),
  stop: () => invoke<void>("player_stop"),
  thumbnail: (key: string) => invoke<string>("player_thumbnail", { key }),
};

/** URL for an image in Kinly's own cache (thumbnails). */
export const cacheImageUrl = (path: string) => convertFileSrc(path);

export type PlayerProp = { name: string; value: unknown };
export type PlayerEvent =
  | { type: "start-file" | "file-loaded" | "playback-restart" | "shutdown" }
  | { type: "end-file"; reason: number }
  | { type: "error"; message: string };

export const onPlayerProp = (cb: (p: PlayerProp) => void): Promise<UnlistenFn> =>
  listen<PlayerProp>("player:prop", (e) => cb(e.payload));
export const onPlayerEvent = (cb: (e: PlayerEvent) => void): Promise<UnlistenFn> =>
  listen<PlayerEvent>("player:event", (e) => cb(e.payload));

// Subtitles
export type PreparedSub = {
  path: string;
  format: "srt" | "vtt" | "ass";
  encoding: string;
  cueCount: number;
  firstCueSec: number;
  lastCueSec: number;
  content: { language: string | null; script: string; confidence: number; sdhRatio: number };
};
export type Sidecar = { path: string; name: string; tokens: string[] };

export const subsFetch = (url: string) => invoke<PreparedSub>("subs_fetch", { url });
export const subsLoadLocal = (path: string) => invoke<PreparedSub>("subs_load_local", { path });
export const subsFindSidecars = (videoPath: string) => invoke<Sidecar[]>("subs_find_sidecars", { videoPath });

export type SyncReport = {
  /** "piecewise": the offset changes during the video; load `retimedPath` instead. */
  status: "fit" | "piecewise" | "inconsistent" | "uncertain" | "busy";
  offsetSec: number;
  ratio: number;
  strength: number;
  agreeingWindows: number;
  analysedWindows: number;
  windowOffsets: (number | null)[];
  /** Piecewise: offset from each subtitle time on. */
  segments: { fromSec: number; offset: number }[];
  retimedPath?: string;
  /** Seconds of audio analysed. */
  audioSec: number;
  deep: boolean;
  elapsedMs: number;
  /** Human-readable explanation of the status (why it fit, or why not). */
  reason?: string;
};
export const syncSubtitle = (args: {
  media: string;
  subtitlePath: string;
  durationSec: number;
  audioFfIndex?: number | null;
  headers?: Record<string, string>;
  bytesPerSec?: number | null;
  manual?: boolean;
  /** "Sync again (deeper)": more audio, wider search. */
  deep?: boolean;
}) => invoke<SyncReport>("sync_subtitle", { args });

// Local media
export type LocalFile = { path: string; name: string; size: number; modified: number };
export const localScan = (dir: string) => invoke<LocalFile[]>("local_scan", { dir });

// Downloads page: finished videos in the XDG download folder plus the user's extra folders.
export type DownloadsListing = {
  dir: string | null;
  downloads: LocalFile[];
  folders: { dir: string; files: LocalFile[]; error: string | null }[];
};
export const downloadsList = (extra: string[]) => invoke<DownloadsListing>("downloads_list", { extra });
/** A video in the download folder finished downloading (size steady across two polls). */
export const onDownloadFinished = (cb: (f: LocalFile) => void): Promise<UnlistenFn> =>
  listen<LocalFile>("downloads:new", (e) => cb(e.payload));

// In-app downloads (download.rs): every download Kinly makes is recorded, and only recorded files
// can be deleted from Kinly. `total` is 0 when the server doesn't send a size.
export type DownloadState = "running" | "done" | "failed" | "interrupted" | "missing" | "cancelled";
export type DownloadInfo = { title?: string; metaId?: string; type?: string; season?: number; episode?: number };
export type DownloadRecord = {
  id: number;
  name: string;
  path: string;
  received: number;
  total: number;
  state: DownloadState;
  error: string | null;
  created: number;
  finished: number | null;
  info: DownloadInfo;
};
/** `dir` null: the default folder (Videos). */
export const downloadStart = (url: string, name: string, opts: { headers?: Record<string, string>; dir?: string | null; info?: DownloadInfo } = {}) =>
  invoke<DownloadRecord>("download_start", { url, name, headers: opts.headers, dir: opts.dir ?? null, info: opts.info });
/** Cancels a running download, or dismisses a failed or interrupted one. */
export const downloadCancel = (id: number) => invoke<void>("download_cancel", { id });
/** Deletes a finished download's file and record (refused while it downloads or plays). */
export const downloadDelete = (id: number) => invoke<void>("download_delete", { id });
export const downloadsManaged = () => invoke<DownloadRecord[]>("downloads_managed");
/** Checks (and creates) a download folder; resolves to the path Kinly will use. */
export const downloadDirCheck = (dir: string) => invoke<string>("download_dir_check", { dir });
export const downloadDefaultDir = () => invoke<string | null>("download_default_dir");
export const onDownloadProgress = (cb: (r: DownloadRecord) => void): Promise<UnlistenFn> =>
  listen<DownloadRecord>("downloads:progress", (e) => cb(e.payload));

// Device capabilities (probed once per session)
export type GpuCaps = {
  vendor: "nvidia" | "amd" | "intel" | "other";
  name: string;
  driver: string;
  discrete: boolean;
  /** The GPU Kinly renders on. */
  active: boolean;
};
export type SystemCaps = {
  gpus: GpuCaps[];
  cpuThreads: number;
  ramMb: number;
  /** Hardware decode support (any API, any GPU). */
  hwdec: { h264: boolean; hevc: boolean; hevc10: boolean; vp9: boolean; av1: boolean };
  /** Largest picture height the hardware decoder accepts, if known. */
  maxHwHeight: number | null;
  /** Highest resolution this device should play smoothly (e.g. 2160, 1080, 720). */
  recommendedMaxHeight: number;
  hwdecApi: "nvdec" | "vaapi" | "none";
};
export const systemCaps = () => invoke<SystemCaps>("system_caps");

// IntroDB (theintrodb.org) skip segments
export type IntroSegment = {
  kind: "intro" | "recap" | "credits" | "preview";
  startSec: number;
  /** null: until the end of the media. */
  endSec: number | null;
};
export const introdbSegments = (args: {
  tmdbId?: number;
  imdbId?: string;
  season?: number;
  episode?: number;
  durationMs?: number;
}) => invoke<{ segments: IntroSegment[] }>("introdb_segments", { args });

// Account email links land on http://localhost:3000; this serves that page while waiting.
export const authCallbackListen = () => invoke<boolean>("auth_callback_listen");
export const onAuthCallback = (cb: (ok: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>("auth:callback", (e) => cb(e.payload));

// External players (mpv, VLC, Celluloid, …) detected on this system.
export type ExternalPlayer = { id: string; name: string; command: string };
export const externalPlayers = () => invoke<ExternalPlayer[]>("external_players");
export const externalOpen = (args: {
  player: string;
  url: string;
  title?: string;
  startSec?: number;
  headers?: Record<string, string>;
  subtitles?: string[];
}) => invoke<void>("external_open", { args });
