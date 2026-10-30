// Stremio addon protocol client: manifest, catalog, meta, stream, subtitles.
// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md

import { httpJson, storeLoad, storeSave } from "./tauri";
import { TtlCache } from "./ttlCache";

export type ExtraProp = { name: string; isRequired?: boolean; options?: string[] };
export type CatalogDef = { type: string; id: string; name?: string; extra?: ExtraProp[] };
export type ResourceDef = string | { name: string; types?: string[]; idPrefixes?: string[] };
export type Manifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  logo?: string;
  resources: ResourceDef[];
  types: string[];
  idPrefixes?: string[];
  catalogs: CatalogDef[];
};
export type Addon = { transportUrl: string; manifest: Manifest };

export type MetaPreview = {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
  genres?: string[];
};
export type Video = {
  id: string;
  title?: string;
  name?: string;
  season?: number;
  episode?: number;
  released?: string;
  thumbnail?: string;
  overview?: string;
};
export type Meta = MetaPreview & {
  videos?: Video[];
  runtime?: string;
  director?: string[];
  cast?: string[];
  country?: string;
};
export type Stream = {
  url?: string;
  infoHash?: string;
  ytId?: string;
  externalUrl?: string;
  name?: string;
  title?: string;
  description?: string;
  behaviorHints?: {
    filename?: string;
    videoSize?: number;
    notWebReady?: boolean;
    proxyHeaders?: { request?: Record<string, string> };
    bingeGroup?: string;
  };
};
export type AddonSubtitle = {
  id: string;
  url: string;
  lang: string;
  subtitleFileName?: string;
  movieReleaseName?: string;
  season?: number;
  episode?: number;
};

export const CINEMETA = "https://v3-cinemeta.strem.io/manifest.json";
export const OPENSUBTITLES = "https://opensubtitles-v3.strem.io/manifest.json";
export const DEFAULT_ADDONS = [CINEMETA, OPENSUBTITLES];

export function baseUrl(transportUrl: string): string {
  return transportUrl.replace(/\/manifest\.json$/, "");
}

export function normalizeTransportUrl(input: string): string {
  let url = input.trim();
  if (url.startsWith("stremio://")) url = "https://" + url.slice("stremio://".length);
  if (!/^https?:\/\//.test(url)) throw new Error("Addon URL must start with https:// or stremio://");
  if (!url.endsWith("/manifest.json")) url = url.replace(/\/$/, "") + "/manifest.json";
  return url;
}

export function supports(addon: Addon, resource: string, type: string, id?: string): boolean {
  const m = addon.manifest;
  for (const r of m.resources ?? []) {
    const name = typeof r === "string" ? r : r.name;
    if (name !== resource) continue;
    const types = typeof r === "string" ? m.types : (r.types ?? m.types);
    const prefixes = typeof r === "string" ? m.idPrefixes : (r.idPrefixes ?? m.idPrefixes);
    if (types && !types.includes(type)) continue;
    if (id && prefixes && prefixes.length > 0 && !prefixes.some((p) => id.startsWith(p))) continue;
    return true;
  }
  return false;
}

export async function fetchManifest(transportUrl: string): Promise<Manifest> {
  const m = await httpJson<Manifest>(transportUrl, 12000);
  if (!m || typeof m.id !== "string" || !Array.isArray(m.resources)) throw new Error("Not a valid addon manifest");
  m.catalogs = Array.isArray(m.catalogs) ? m.catalogs : [];
  return m;
}

// Guest mode's installed addon list, persisted as [{transportUrl, manifest}] in the "addons"
// store. Signed-in profiles each have their own list (see sync.ts).
export async function loadAddons(): Promise<Addon[]> {
  const r = await storeLoad<Addon[]>("addons");
  if (Array.isArray(r.value) && r.value.length > 0) return r.value;
  const fresh: Addon[] = [];
  for (const url of DEFAULT_ADDONS) {
    try {
      fresh.push({ transportUrl: url, manifest: await fetchManifest(url) });
    } catch {
      // Offline at first start: try again next launch rather than saving a partial list.
      return fresh;
    }
  }
  await storeSave("addons", fresh);
  return fresh;
}

export const saveAddons = (addons: Addon[]) => storeSave("addons", addons);

/** The guest list exactly as stored (empty when there is none); never fetches the defaults. */
export async function storedGuestAddons(): Promise<Addon[]> {
  try {
    const r = await storeLoad<Addon[]>("addons");
    return Array.isArray(r.value) ? r.value.filter((a) => a && typeof a.transportUrl === "string" && a.manifest && typeof a.manifest.id === "string") : [];
  } catch {
    return [];
  }
}

// Addon responses (catalogs can be large), bounded so long sessions don't keep growing.
const cache = new TtlCache<Promise<unknown>>(200);
function cached<T>(url: string, ttlMs: number, timeoutMs = 15000): Promise<T> {
  const hit = cache.get(url);
  if (hit) return hit as Promise<T>;
  const value = httpJson<T>(url, timeoutMs);
  cache.set(url, value, ttlMs);
  value.catch(() => cache.deleteIf(url, value));
  return value;
}

function extraPath(extra: Record<string, string | number | undefined>): string {
  const parts = Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `/${parts.join("&")}` : "";
}

export async function getCatalog(
  addon: Addon,
  type: string,
  id: string,
  extra: Record<string, string | number | undefined> = {},
): Promise<MetaPreview[]> {
  const url = `${baseUrl(addon.transportUrl)}/catalog/${type}/${encodeURIComponent(id)}${extraPath(extra)}.json`;
  const r = await cached<{ metas?: MetaPreview[] }>(url, 30 * 60_000);
  return (r.metas ?? []).filter((m) => m && m.id && m.name);
}

export async function getMeta(addons: Addon[], type: string, id: string): Promise<Meta> {
  const providers = addons.filter((a) => supports(a, "meta", type, id));
  let lastErr: unknown = new Error("No metadata addon supports this title");
  for (const a of providers) {
    try {
      const r = await cached<{ meta?: Meta }>(`${baseUrl(a.transportUrl)}/meta/${type}/${encodeURIComponent(id)}.json`, 60 * 60_000);
      if (r.meta) return r.meta;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export type SourceResult<T> = { addon: Addon; items: T[]; error?: string };

/** Query every addon providing `resource` in parallel; one slow or broken addon does not block the rest. */
async function fanOut<T>(addons: Addon[], resource: string, type: string, id: string, key: string, extra = ""): Promise<SourceResult<T>[]> {
  const providers = addons.filter((a) => supports(a, resource, type, id));
  return Promise.all(
    providers.map(async (addon) => {
      try {
        const url = `${baseUrl(addon.transportUrl)}/${resource}/${type}/${encodeURIComponent(id)}${extra}.json`;
        const r = await cached<Record<string, T[]>>(url, 10 * 60_000, 20000);
        return { addon, items: Array.isArray(r[key]) ? r[key] : [] };
      } catch (e) {
        return { addon, items: [], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

export const getStreams = (addons: Addon[], type: string, id: string) => fanOut<Stream>(addons, "stream", type, id, "streams");

export function getSubtitles(addons: Addon[], type: string, id: string, hints: { filename?: string; videoSize?: number } = {}) {
  return fanOut<AddonSubtitle>(addons, "subtitles", type, id, "subtitles", extraPath(hints));
}

export async function searchAll(addons: Addon[], query: string): Promise<{ addon: Addon; catalog: CatalogDef; items: MetaPreview[] }[]> {
  const jobs: Promise<{ addon: Addon; catalog: CatalogDef; items: MetaPreview[] } | null>[] = [];
  for (const addon of addons) {
    for (const catalog of addon.manifest.catalogs) {
      if (!catalog.extra?.some((e) => e.name === "search")) continue;
      jobs.push(
        getCatalog(addon, catalog.type, catalog.id, { search: query })
          .then((items) => ({ addon, catalog, items }))
          .catch(() => null),
      );
    }
  }
  return (await Promise.all(jobs)).filter((x): x is NonNullable<typeof x> => x !== null && x.items.length > 0);
}
