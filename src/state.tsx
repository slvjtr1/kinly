import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_SETTINGS, resolvePerformanceMode, sanitizeSettings, type Settings } from "./lib/settings";
import { useCaps } from "./lib/caps";
import { nextStack, popStack } from "./lib/navStack";
import { onShutdown } from "./lib/shutdown";
import { storeLoad, storeSave } from "./lib/tauri";
import type { PlayRequest } from "./views/Player";

export type Route =
  | { name: "home" }
  | { name: "browse"; type: "movie" | "series" }
  | { name: "search"; query: string }
  | { name: "detail"; type: string; id: string }
  | { name: "library" }
  | { name: "local" }
  | { name: "settings"; section?: string }
  | { name: "addons" }
  | { name: "player"; req: PlayRequest };

type Toast = { id: number; text: string; kind: "info" | "error" };

type Ctx = {
  settings: Settings;
  update: (fn: (s: Settings) => Settings) => void;
  route: Route;
  /** `replace` swaps the current view instead of stacking on top of it. */
  navigate: (r: Route, opts?: { replace?: boolean }) => void;
  back: () => void;
  /** False on a root view (Home, Library, …), where Back has nothing to return to. */
  canGoBack: boolean;
  toast: (text: string, kind?: Toast["kind"]) => void;
};

const AppCtx = createContext<Ctx | null>(null);

// Toasts from outside React (global error handlers, plain modules). Set while the provider is mounted.
let globalToast: Ctx["toast"] | null = null;
export function notify(text: string, kind: Toast["kind"] = "info") {
  globalToast?.(text, kind);
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside provider");
  return c;
}

export function AppProvider({ children, initial }: { children: ReactNode; initial: Settings }) {
  const [settings, setSettings] = useState(initial);
  const [stack, setStack] = useState<Route[]>([{ name: "home" }]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);
  const caps = useCaps();

  const pending = useRef<Settings | null>(null);
  const update = useCallback((fn: (s: Settings) => Settings) => {
    setSettings((prev) => {
      const next = sanitizeSettings(fn(prev));
      pending.current = next;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        pending.current = null;
        void storeSave("settings", next);
      }, 400);
      return next;
    });
  }, []);
  useEffect(
    () =>
      onShutdown(() => {
        const next = pending.current;
        if (!next) return;
        window.clearTimeout(saveTimer.current);
        pending.current = null;
        return storeSave("settings", next);
      }),
    [],
  );

  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = settings.appearance.theme;
    el.dataset.reduceMotion = String(settings.appearance.reduceMotion);
    el.dataset.perf = resolvePerformanceMode(settings.appearance.performanceMode, caps);
    el.dataset.tv = String(settings.appearance.tvMode);
    el.style.zoom = String(settings.appearance.uiScale);
  }, [settings.appearance, caps]);

  const navigate = useCallback((r: Route, opts?: { replace?: boolean }) => setStack((s) => nextStack(s, r, opts?.replace)), []);
  const back = useCallback(() => setStack(popStack), []);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);

  useEffect(() => {
    globalToast = toast;
    return () => {
      if (globalToast === toast) globalToast = null;
    };
  }, [toast]);

  // Memoised so a toast appearing or disappearing does not re-render every consumer.
  const route = stack[stack.length - 1];
  const canGoBack = stack.length > 1;
  const value = useMemo(() => ({ settings, update, route, navigate, back, canGoBack, toast }), [settings, update, route, navigate, back, canGoBack, toast]);
  return (
    <AppCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  );
}

export async function loadSettings(): Promise<{ settings: Settings; recovered: string | null }> {
  try {
    const r = await storeLoad<unknown>("settings");
    return { settings: sanitizeSettings(r.value ?? DEFAULT_SETTINGS), recovered: r.recoveredFrom };
  } catch {
    return { settings: DEFAULT_SETTINGS, recovered: null };
  }
}
