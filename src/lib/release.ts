// Release-name parsing for local files, streams and subtitle names.

export type ReleaseInfo = {
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  resolution: number | null; // 2160, 1080, 720, 480
  /** Lower-case tokens that identify a specific encode (source, codec, group). */
  tags: string[];
  group: string | null;
};

const SOURCE_TAGS = new Set([
  "bluray", "bdrip", "brrip", "remux", "webdl", "webrip", "web", "hdtv", "dvdrip", "hdrip", "amzn", "nf",
  "dsnp", "hmax", "atvp", "hulu", "pcok", "x264", "x265", "h264", "h265", "hevc", "avc", "10bit",
  "hdr", "hdr10", "dv", "dovi", "atmos", "ddp5", "dts", "aac", "proper", "repack", "extended", "imax",
  "uncut", "directors", "remastered", "cam", "hdcam", "telesync", "hdts", "dvdscr", "xvid", "dvd",
]);

const EP_PATTERNS: RegExp[] = [
  /\bs(\d{1,2})[ ._-]?e(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{1,3})\b/i,
  /\bseason[ ._-]?(\d{1,2})[ ._-]*episode[ ._-]?(\d{1,3})\b/i,
];

export function stripExtension(name: string): string {
  return name.replace(/\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpe?g|srt|vtt|ass|ssa|sub)$/i, "");
}

export function parseRelease(raw: string): ReleaseInfo {
  const name = stripExtension(raw.split(/[\\/]/).pop() ?? raw);
  const flat = name.replace(/[._]+/g, " ");
  let season: number | null = null;
  let episode: number | null = null;
  let cut = flat.length;
  for (const re of EP_PATTERNS) {
    const m = flat.match(re);
    if (m) {
      season = Number(m[1]);
      episode = Number(m[2]);
      cut = Math.min(cut, m.index ?? cut);
      break;
    }
  }
  const yearM = flat.match(/\b(19[2-9]\d|20[0-4]\d)\b/);
  const year = yearM ? Number(yearM[1]) : null;
  if (yearM?.index != null && yearM.index > 0) cut = Math.min(cut, yearM.index);
  const resM = flat.match(/\b(2160|1080|720|576|480)p\b/i) ?? (/\b4k\b|\buhd\b/i.test(flat) ? ["", "2160"] : null);
  const resolution = resM ? Number(resM[1]) : null;
  if (resM && "index" in resM && resM.index != null && resM.index > 0) cut = Math.min(cut, resM.index);

  const words = flat.toLowerCase().replace(/[[\]()]/g, " ").split(/[\s-]+/).filter(Boolean);
  const tags = words.map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => SOURCE_TAGS.has(w) || w === "webdl");
  const groupM = name.match(/-([A-Za-z0-9]{2,20})(?:\[[^\]]*\])?$/);
  const group = groupM ? groupM[1].toLowerCase() : null;
  if (group) tags.push(`grp:${group}`);

  const title = flat
    .slice(0, cut)
    .replace(/[[(].*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { title: title || flat.trim(), year, season, episode, resolution, tags: [...new Set(tags)], group };
}

/** Jaccard similarity of encode tags + resolution, 0..1. Null when either side has nothing to compare. */
export function releaseSimilarity(a: ReleaseInfo, b: ReleaseInfo): number | null {
  const ta = new Set(a.tags);
  const tb = new Set(b.tags);
  if (a.resolution) ta.add(`r${a.resolution}`);
  if (b.resolution) tb.add(`r${b.resolution}`);
  if (ta.size === 0 || tb.size === 0) return null;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
