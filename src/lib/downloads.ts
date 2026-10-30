// Pure helpers for the Downloads page's list of Kinly-managed downloads (unit tested).

import type { DownloadRecord } from "./tauri";

export type DownloadSort = "date" | "title" | "size" | "status";
export const DOWNLOAD_SORTS: { id: DownloadSort; label: string }[] = [
  { id: "date", label: "Newest" },
  { id: "title", label: "Title" },
  { id: "size", label: "Size" },
  { id: "status", label: "Status" },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** "Dark · S01E02", "Dune", or the file name when Kinly knows nothing else. */
export function downloadTitle(r: Pick<DownloadRecord, "name" | "info">): string {
  const t = r.info.title?.trim();
  if (!t) return r.name;
  return r.info.season != null && r.info.episode != null ? `${t} · S${pad(r.info.season)}E${pad(r.info.episode)}` : t;
}

/** Size on disk (or so far): the received bytes, else the announced total. */
export const downloadSize = (r: Pick<DownloadRecord, "received" | "total">) => r.received || r.total;

const STATUS_ORDER: Record<string, number> = { running: 0, failed: 1, interrupted: 2, missing: 3, done: 4 };

export function sortDownloads(list: DownloadRecord[], by: DownloadSort): DownloadRecord[] {
  const out = [...list];
  const newest = (a: DownloadRecord, b: DownloadRecord) => b.created - a.created || b.id - a.id;
  switch (by) {
    case "title":
      return out.sort((a, b) => downloadTitle(a).localeCompare(downloadTitle(b), undefined, { numeric: true, sensitivity: "base" }) || newest(a, b));
    case "size":
      return out.sort((a, b) => downloadSize(b) - downloadSize(a) || newest(a, b));
    case "status":
      return out.sort((a, b) => (STATUS_ORDER[a.state] ?? 9) - (STATUS_ORDER[b.state] ?? 9) || newest(a, b));
    default:
      return out.sort(newest);
  }
}

/** Case-insensitive match on the title and the file name. */
export function matchesDownload(r: DownloadRecord, filter: string): boolean {
  const f = filter.trim().toLocaleLowerCase();
  return !f || downloadTitle(r).toLocaleLowerCase().includes(f) || r.name.toLocaleLowerCase().includes(f);
}

/** Merges a progress event into the list: replaces the record, drops cancelled ones, adds new ones. */
export function applyDownloadEvent(list: DownloadRecord[], r: DownloadRecord): DownloadRecord[] {
  const rest = list.filter((x) => x.id !== r.id);
  return r.state === "cancelled" ? rest : [r, ...rest];
}
