// Device capabilities (GPU decode support, RAM, CPU), loaded once and cached.
// Used by stream ranking to prefer what the device plays smoothly. When the
// backend cannot report them, ranking falls back to resolution order.

import { useSyncExternalStore } from "react";
import { systemCaps, type SystemCaps } from "./tauri";
import type { QualityLimit } from "./settings";
import type { RankCaps } from "./streams";

let caps: SystemCaps | null = null;
let pending: Promise<SystemCaps | null> | null = null;
const subs = new Set<() => void>();

export function loadCaps(): Promise<SystemCaps | null> {
  pending ??= systemCaps()
    .then((c) => {
      caps = c;
      subs.forEach((f) => f());
      return c;
    })
    .catch(() => null);
  return pending;
}

export const getCaps = () => caps;

export function useCaps(): SystemCaps | null {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    getCaps,
  );
}

/**
 * Ranking inputs from the device and the user's settings. "auto" uses the
 * device's recommended height (no cap when unknown); turning hardware decoding
 * off means every codec is decoded on the CPU.
 */
export function rankCapsFor(c: SystemCaps | null, limit: QualityLimit, hwdecEnabled = true): RankCaps {
  const maxHeight = limit === "auto" ? (c?.recommendedMaxHeight || null) : limit;
  if (!c) return { maxHeight, hwdec: null };
  const off = { h264: false, hevc: false, hevc10: false, vp9: false, av1: false };
  return { maxHeight, hwdec: hwdecEnabled ? c.hwdec : off, maxHwHeight: hwdecEnabled ? c.maxHwHeight || null : null };
}
