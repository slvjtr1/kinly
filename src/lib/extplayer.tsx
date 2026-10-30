// External players: detection cache, hand-off, and the Settings → Playback row.
//
// Exports for other views:
//   <ExternalPlayerSetting/>         Settings → Playback ("Default player")
//   openExternally(req, startSec)    Open a PlayRequest in the default (or a given) external player
//   useExternalPlayers()             Detected players (null while detecting)
import { useEffect, useState } from "react";
import { sanitizeSettings } from "./settings";
import { externalOpen, externalPlayers, storeLoad, type ExternalPlayer } from "./tauri";
import { useApp } from "../state";
import type { PlayRequest } from "../views/Player";

export type { ExternalPlayer };

let detected: Promise<ExternalPlayer[]> | null = null;

/** Installed players; detected once per session unless `refresh`. */
export function listExternalPlayers(refresh = false): Promise<ExternalPlayer[]> {
  if (!detected || refresh) {
    detected = externalPlayers().catch(() => {
      detected = null;
      return [];
    });
  }
  return detected;
}

export function useExternalPlayers(): ExternalPlayer[] | null {
  const [list, setList] = useState<ExternalPlayer[] | null>(null);
  useEffect(() => {
    let live = true;
    void listExternalPlayers().then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, []);
  return list;
}

/** True when the user's default player is an external one. */
export const isExternalDefault = (playerSetting: string | undefined) => !!playerSetting && playerSetting !== "builtin";

/**
 * Hand a stream or local file to an external player at `startSec`.
 * The player defaults to the `playback.player` setting; pass `opts.player` to override.
 * Resolves with the player used; rejects with a user-facing message.
 */
export async function openExternally(
  req: PlayRequest,
  startSec?: number,
  opts: { player?: string; subtitles?: string[] } = {},
): Promise<ExternalPlayer> {
  let id = opts.player;
  if (!id) {
    const stored = await storeLoad<unknown>("settings").catch(() => null);
    id = sanitizeSettings(stored?.value ?? null).playback.player;
  }
  if (!id || id === "builtin") throw new Error("No external player is selected");
  const players = await listExternalPlayers();
  const p = players.find((x) => x.id === id) ?? (await listExternalPlayers(true)).find((x) => x.id === id);
  if (!p) throw new Error("That player is no longer installed");
  const episode = req.season != null && req.episode != null ? ` · S${req.season}E${req.episode}${req.episodeTitle ? ` · ${req.episodeTitle}` : ""}` : "";
  const title = req.title.includes(`S${req.season}E${req.episode}`) ? req.title : `${req.title}${episode}`;
  await externalOpen({
    player: p.id,
    url: req.url,
    title,
    startSec: startSec != null && startSec > 1 ? startSec : undefined,
    headers: req.headers,
    subtitles: opts.subtitles?.length ? opts.subtitles : undefined,
  });
  return p;
}

/** Settings → Playback: the default player. Markup matches Settings.tsx rows. */
export function ExternalPlayerSetting() {
  const { settings, update } = useApp();
  const players = useExternalPlayers();
  const value = settings.playback.player;
  const missing = players != null && value !== "builtin" && !players.some((p) => p.id === value);
  const set = (player: string) => update((s) => ({ ...s, playback: { ...s.playback, player } }));
  return (
    <div className="setting">
      <div>
        <div className="setting-label">Default player</div>
        <div className="setting-help">
          {players == null
            ? "Looking for installed players…"
            : players.length === 0
              ? "Kinly's built-in player. Install mpv, VLC, Celluloid, SMPlayer or Haruna (also as Flatpak) to use one of them instead."
              : "External players open in their own window with the stream, start position, title and Kinly's chosen subtitle. Progress is not tracked while you watch there."}
          {missing && <> The selected player is no longer installed; the built-in player is used.</>}
        </div>
      </div>
      <div className="setting-control">
        <select className="select" value={missing ? "builtin" : value} onChange={(e) => set(e.target.value)} aria-label="Default player" disabled={players == null}>
          <option value="builtin">Kinly (built-in)</option>
          {(players ?? []).map((p) => (
            <option key={p.id} value={p.id} title={p.command}>{p.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
