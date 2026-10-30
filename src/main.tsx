import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppProvider, loadSettings, notify, useApp } from "./state";
import { loadLibrary } from "./lib/library";
import { initAddons } from "./lib/useAddons";
import { loadCredentials } from "./lib/tmdb";
import { installCloseHandler } from "./lib/shutdown";
import { uiLog } from "./lib/tauri";
import { initAccount, showAuthScreen, showProfilePicker, useAccount, useScreens } from "./lib/account";
import { initSync, useCloudSettings, useSync } from "./lib/sync";
import { initTrakt } from "./lib/trakt";
import { Splash } from "./components/Splash";
import Auth from "./views/Auth";
import Profiles from "./views/Profiles";
import "./styles/app.css";
import "./styles/account.css";

window.addEventListener("error", (e) => void uiLog("error", `${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  void uiLog("error", `unhandled: ${msg}`);
  // A link button that called openUrl without handling the error: say so instead of doing nothing.
  if (/open url|opener|xdg-open|default browser/i.test(msg)) notify(`Couldn't open your browser: ${msg}`, "error");
});

if (import.meta.env.VITE_PERF_PROBE === "1") void import("./perfProbe").then((m) => m.startPerfProbe());

async function boot() {
  const [{ settings, recovered }, libRecovered] = await Promise.all([loadSettings(), loadLibrary().catch(() => null)]);
  void initAddons();
  void loadCredentials();
  void initSync();
  void initAccount();
  void initTrakt();
  void installCloseHandler().catch((e) => void uiLog("warn", `close handler: ${e}`));
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AppProvider initial={settings}>
        <Root />
        {(recovered || libRecovered) && <RecoveredNotice paths={[recovered, libRecovered].filter(Boolean) as string[]} />}
      </AppProvider>
    </StrictMode>,
  );
}

/**
 * First-launch / account gate. <App/> is always mounted at the same place in the tree (so it boots
 * and loads data underneath, and is never remounted); the splash, auth screen and profile picker
 * are overlays on top of it, and the app is inert while one of them is showing.
 */
function Root() {
  const { settings, update } = useApp();
  useCloudSettings(settings, update);
  const account = useAccount();
  const sync = useSync();
  const screens = useScreens();
  const [splash, setSplash] = useState(true);
  const endSplash = useCallback(() => setSplash(false), []);

  const needAuth = account.status === "undecided" || (screens.auth && account.status === "guest");
  const needPicker = account.status === "signedIn" && (!sync.active || screens.picker !== false);
  const blocked = splash || account.status === "loading" || needAuth || needPicker;

  return (
    <>
      <div className="app-gate" inert={blocked}>
        <App />
      </div>
      {!splash && needAuth && <Auth onClose={account.status === "guest" ? () => showAuthScreen(false) : undefined} />}
      {!splash && !needAuth && needPicker && (
        <Profiles
          key={screens.picker || "pick"}
          manage={screens.picker === "manage"}
          onClose={sync.active ? () => showProfilePicker(false) : undefined}
        />
      )}
      {splash && <Splash onDone={endSplash} reduceMotion={settings.appearance.reduceMotion} />}
    </>
  );
}

function RecoveredNotice({ paths }: { paths: string[] }) {
  return (
    <div className="toasts" style={{ bottom: 90 }}>
      <div className="toast error">
        A saved file was unreadable and has been set aside (not deleted): {paths.join(", ")}. Defaults are in use.
      </div>
    </div>
  );
}

void boot();
