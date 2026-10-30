// Stream classification and ranking. Kinly plays direct HTTP(S) streams only:
// there is no torrent engine, so bare infoHash results are listed as unsupported.

import type { Addon, Meta, Stream, Video } from "./addons";
import { parseRelease } from "./release";

export type RankedStream = {
  stream: Stream;
  addonName: string;
  playable: boolean;
  why?: string;
  resolution: number | null;
  hdr: boolean;
  /** Source, codec, HDR and audio features read from the stream's name/title. */
  tags: StreamTag[];
  sizeBytes: number | null;
  label: string;
  detail: string;
  score: number;
  /** Set when this device is unlikely to play the stream smoothly (above the quality cap, or CPU decode at high resolution). */
  stutter?: string;
};

/** What the ranking knows about the device. Every field is optional: unknown means "no penalty". */
export type RankCaps = {
  /** Streams taller than this rank below every stream at or under it. */
  maxHeight?: number | null;
  hwdec?: { h264: boolean; hevc: boolean; hevc10: boolean; vp9: boolean; av1: boolean } | null;
  /** Largest height the hardware decoder handles. */
  maxHwHeight?: number | null;
};

const SOURCE_RANK: Record<string, number> = { remux: 5, bluray: 4, webdl: 3, webrip: 2, hdtv: 1 };

export type StreamTag = { id: string; label: string; kind: "source" | "codec" | "hdr" | "audio" };

// Order matters within a kind: the first match wins (e.g. "DV" before "HDR").
const TAG_RULES: { id: string; label: string; kind: StreamTag["kind"]; re: RegExp }[] = [
  { id: "remux", label: "BluRay REMUX", kind: "source", re: /\b(bd|blu-?ray|uhd)?[ .-]?remux\b/i },
  { id: "bluray", label: "BluRay", kind: "source", re: /\b(blu-?ray|bdrip|brrip|bd25|bd50)\b/i },
  { id: "webrip", label: "WEBRip", kind: "source", re: /\bweb[ .-]?rip\b/i },
  { id: "webdl", label: "WEB-DL", kind: "source", re: /\bweb([ .-]?dl)?\b/i },
  { id: "hdtv", label: "HDTV", kind: "source", re: /\bhdtv\b/i },
  { id: "cam", label: "CAM", kind: "source", re: /\b(cam|hdcam|camrip|telesync|hdts)\b/i },
  { id: "av1", label: "AV1", kind: "codec", re: /\bav1\b/i },
  { id: "hevc", label: "HEVC x265", kind: "codec", re: /\b(hevc|[xh][ .]?265)\b/i },
  { id: "avc", label: "x264", kind: "codec", re: /\b(avc|[xh][ .]?264)\b/i },
  { id: "dv", label: "Dolby Vision", kind: "hdr", re: /\b(dolby[ .-]?vision|dovi|dv)\b/i },
  { id: "hdr10p", label: "HDR10+", kind: "hdr", re: /\bhdr10(\+|plus)/i },
  { id: "hdr", label: "HDR", kind: "hdr", re: /\bhdr(10)?\b/i },
  { id: "atmos", label: "Atmos", kind: "audio", re: /\batmos\b/i },
  { id: "truehd", label: "TrueHD", kind: "audio", re: /\btrue[ .-]?hd\b/i },
  { id: "dts", label: "DTS", kind: "audio", re: /\bdts([ .-]?(hd|x|ma))*\b/i },
  { id: "ddp", label: "DD+", kind: "audio", re: /\b(ddp|dd\+|e-?ac-?3|eac3)/i },
  { id: "ch71", label: "7.1", kind: "audio", re: /(?<!\d)7[ .]1(?!\d)/ },
  { id: "ch51", label: "5.1", kind: "audio", re: /(?<!\d)5[ .]1(?!\d)/ },
];

export function streamTags(text: string): StreamTag[] {
  const out: StreamTag[] = [];
  const taken = new Set<string>();
  for (const r of TAG_RULES) {
    // One source and one codec; HDR flavours and audio features may combine (DV + HDR10+, Atmos + 7.1).
    if ((r.kind === "source" || r.kind === "codec") && taken.has(r.kind)) continue;
    if (r.id === "hdr" && out.some((t) => t.kind === "hdr")) continue;
    if (r.id === "ch51" && out.some((t) => t.id === "ch71")) continue;
    if (r.re.test(text)) {
      out.push({ id: r.id, label: r.label, kind: r.kind });
      taken.add(r.kind);
    }
  }
  return out;
}

function parseSize(text: string): number | null {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(GB|GiB|MB|MiB)\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return /g/i.test(m[2]) ? n * 1024 ** 3 : n * 1024 ** 2;
}

export function classify(stream: Stream): { playable: boolean; why?: string } {
  if (stream.url && /^https?:\/\//i.test(stream.url)) return { playable: true };
  if (stream.infoHash) return { playable: false, why: "Torrent source (configure a debrid service in the addon)" };
  if (stream.ytId) return { playable: false, why: "YouTube source" };
  if (stream.externalUrl) return { playable: false, why: "Opens in an external website" };
  return { playable: false, why: "No playable URL" };
}

/** Why a stream would be decoded on the CPU at a resolution where that stutters, or null. */
export function cpuDecodeRisk(text: string, tags: StreamTag[], resolution: number | null, caps: RankCaps): string | null {
  if (!caps.hwdec || !resolution || resolution <= 1080) return null;
  const hw = caps.hwdec;
  const codec = tags.find((t) => t.kind === "codec")?.id;
  const tenBit = /\b10[ .-]?bit\b|\bhi10p?\b/i.test(text) || tags.some((t) => t.kind === "hdr");
  if (caps.maxHwHeight && resolution > caps.maxHwHeight) return `No hardware decoding above ${caps.maxHwHeight}p`;
  if (codec === "av1" && !hw.av1) return "AV1 without hardware decoding";
  if (codec === "hevc" && tenBit && !hw.hevc10) return "10-bit HEVC without hardware decoding";
  if (codec === "hevc" && !hw.hevc) return "HEVC without hardware decoding";
  if (/\bvp9\b/i.test(text) && !hw.vp9) return "VP9 without hardware decoding";
  if (codec === "avc" && !hw.h264) return "H.264 without hardware decoding";
  return null;
}

/** Penalty for sizes that do not fit the resolution (fakes, re-encodes starved of bitrate). */
function sizeSanity(sizeBytes: number | null, resolution: number | null): number {
  if (!sizeBytes || !resolution) return 0;
  const gb = sizeBytes / 1024 ** 3;
  const floor = resolution >= 2160 ? 4 : resolution >= 1080 ? 1 : 0.3;
  return gb < floor * 0.25 ? -2 : gb < floor ? -1 : 0;
}

/**
 * Every stream is kept. Order: playable streams this device plays smoothly,
 * then playable ones that may stutter, then unplayable ones. Within a tier:
 * higher resolution, better source (Remux > BluRay > WEB-DL > WEBRip > HDTV),
 * sane size, then the addon's own order. CAM releases sink within their tier.
 */
export function rankStreams(results: { addon: Addon; items: Stream[] }[], caps: RankCaps = {}): RankedStream[] {
  const out: RankedStream[] = [];
  for (const { addon, items } of results) {
    items.forEach((stream, index) => {
      const text = [stream.name, stream.title, stream.description, stream.behaviorHints?.filename].filter(Boolean).join(" ");
      const resolution = parseRelease(text.replace(/\n/g, " ")).resolution;
      const tags = streamTags(text);
      const hdr = tags.some((t) => t.kind === "hdr");
      const sizeBytes = stream.behaviorHints?.videoSize ?? parseSize(text);
      const { playable, why } = classify(stream);
      const overCap = !!(caps.maxHeight && resolution && resolution > caps.maxHeight);
      const stutter = overCap ? `Above ${caps.maxHeight}p` : cpuDecodeRisk(text, tags, resolution, caps) ?? undefined;
      const source = tags.find((t) => t.kind === "source")?.id;
      const tier = !playable ? 0 : stutter ? 1 : 2;
      const score =
        tier * 1e7 +
        (source === "cam" ? -5e6 : 0) +
        (resolution ?? 0) * 1000 +
        (SOURCE_RANK[source ?? ""] ?? 0) * 100 +
        sizeSanity(sizeBytes, resolution) * 10 -
        Math.min(index, 999) / 100; // the addon's own ordering is a useful tie-break
      const lines = (stream.title ?? stream.description ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
      out.push({
        stream,
        addonName: addon.manifest.name,
        playable,
        why,
        resolution,
        hdr,
        tags,
        sizeBytes,
        label: (stream.name ?? addon.manifest.name).replace(/\n/g, " "),
        detail: lines.join(" · "),
        score,
        stutter: playable ? stutter : undefined,
      });
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

export type QualityGroup = "2160" | "1080" | "720" | "sd" | "other";

export function qualityGroup(r: number | null): QualityGroup {
  if (!r) return "other";
  if (r >= 2160) return "2160";
  if (r >= 1080) return "1080";
  if (r >= 720) return "720";
  return "sd";
}

export const QUALITY_LABEL: Record<QualityGroup, string> = { "2160": "4K", "1080": "1080p", "720": "720p", sd: "SD", other: "Unknown" };

export function formatBytes(n: number | null): string {
  if (!n) return "";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** File name for an in-app download: the source's own file name, else the title (and episode). */
export function downloadName(meta: Pick<Meta, "name" | "releaseInfo">, rs: Pick<RankedStream, "stream">, video: Pick<Video, "season" | "episode"> | null): string {
  const hinted = rs.stream.behaviorHints?.filename?.trim();
  if (hinted) return hinted;
  const pad = (n?: number) => String(n ?? 0).padStart(2, "0");
  if (video?.season != null) return `${meta.name} S${pad(video.season)}E${pad(video.episode)}`;
  const year = meta.releaseInfo?.slice(0, 4);
  return /^\d{4}$/.test(year ?? "") ? `${meta.name} (${year})` : meta.name;
}
