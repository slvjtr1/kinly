// Work that must finish before the window closes: capturing state (e.g. the playback position),
// then writing pending changes that are otherwise saved after a short debounce.

import { getCurrentWindow } from "@tauri-apps/api/window";

type Hook = () => void | Promise<unknown>;
const phases = { capture: new Set<Hook>(), flush: new Set<Hook>() };

/** Registers `fn` to run when the app closes. "capture" hooks run before "flush" hooks. Returns an unregister function. */
export function onShutdown(fn: Hook, phase: keyof typeof phases = "flush"): () => void {
  phases[phase].add(fn);
  return () => void phases[phase].delete(fn);
}

const settle = (hooks: Set<Hook>) => Promise.allSettled([...hooks].map((f) => Promise.resolve().then(f)));

/** Runs every hook, capture phase first. Never rejects, and gives up waiting after `timeoutMs`. */
export async function runShutdown(timeoutMs = 3000): Promise<void> {
  const all = (async () => {
    await settle(phases.capture);
    await settle(phases.flush);
  })();
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
}

/** Holds the window's close until pending writes are done (bounded by runShutdown's timeout). */
export async function installCloseHandler(): Promise<void> {
  await getCurrentWindow().onCloseRequested(async () => {
    // The window is destroyed after this returns, so it must not throw.
    await runShutdown().catch(() => {});
  });
}
