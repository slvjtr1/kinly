import { CHANNEL_LABEL } from "./lib/channel";
import { useCallback, useEffect, useRef, useState, type UIEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { localRequest, useDownloadNotifications } from "./views/Downloads";
import { Maximize, Minimize, Puzzle, Search as SearchIcon, Settings as SettingsIcon } from "lucide-react";
import { useApp, type Route } from "./state";
import { loadCaps } from "./lib/caps";
import Home from "./views/Home";
import Browse from "./views/Browse";
import Search from "./views/Search";
import Detail from "./views/Detail";
import Player from "./views/Player";
import Library from "./views/Library";
import Downloads from "./views/Downloads";
import SettingsView from "./views/Settings";
import AddonsView from "./views/Addons";
import { ProfileSwitcher } from "./views/Profiles";

const NAV: { label: string; route: Route; match: Route["name"][]; type?: string }[] = [
  { label: "Home", route: { name: "home" }, match: ["home"] },
  { label: "Movies", route: { name: "browse", type: "movie" }, match: ["browse"], type: "movie" },
  { label: "Series", route: { name: "browse", type: "series" }, match: ["browse"], type: "series" },
  { label: "Library", route: { name: "library" }, match: ["library"] },
  { label: "Downloads", route: { name: "local" }, match: ["local"] },
];

export default function App() {
  const { route, navigate, settings } = useApp();
  const [scrolled, setScrolled] = useState(false);
  const scrolledRef = useRef(false);
  useDownloadNotifications();

  useEffect(() => void loadCaps(), []);
  useEffect(() => {
    scrolledRef.current = false;
    setScrolled(false);
  }, [route]);
  // Scroll events fire every frame while scrolling; only the 8px threshold crossing re-renders.
  const onMainScroll = useCallback((e: UIEvent<HTMLElement>) => {
    const next = e.currentTarget.scrollTop > 8;
    if (next !== scrolledRef.current) {
      scrolledRef.current = next;
      setScrolled(next);
    }
  }, []);

  // Files opened from the file manager: at launch, or sent to the running instance. A file opened
  // while another one plays replaces it. The ref keeps the long-lived listener on current values.
  const live = useRef({ resume: settings.playback.resume, playing: route.name === "player" });
  live.current = { resume: settings.playback.resume, playing: route.name === "player" };
  useEffect(() => {
    const open = (path: string) =>
      navigate({ name: "player", req: localRequest({ path, name: path.split(/[\\/]/).pop() ?? path }, live.current.resume) }, { replace: live.current.playing });
    void invoke<string | null>("take_launch_file").then((p) => p && open(p));
    const un = listen<string>("open-file", (e) => open(e.payload));
    return () => void un.then((f) => f());
  }, [navigate]);

  const [fullscreen, setFullscreen] = useState(false);
  const toggleFullscreen = async () => {
    const w = getCurrentWindow();
    const next = !(await w.isFullscreen());
    await w.setFullscreen(next);
    setFullscreen(next);
  };
  useEffect(() => {
    // Keep the button in sync when fullscreen changes elsewhere (the player, the window manager).
    const w = getCurrentWindow();
    void w.isFullscreen().then(setFullscreen);
    const un = w.onResized(() => void w.isFullscreen().then(setFullscreen));
    return () => void un.then((u) => u());
  }, [route.name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (route.name === "player") return;
      if (e.key === "F11") {
        e.preventDefault();
        void toggleFullscreen();
        return;
      }
      const t = e.target;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
      if ((e.ctrlKey && e.key === "k") || (!typing && e.key === "/")) {
        e.preventDefault();
        navigate({ name: "search", query: "" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route.name, navigate]);

  if (route.name === "player") return <Player key={route.req.videoId + route.req.url} req={route.req} />;

  const isActive = (n: (typeof NAV)[number]) => n.match.includes(route.name) && (!n.type || (route.name === "browse" && route.type === n.type));
  return (
    <div className="shell">
      <header className={`topbar ${scrolled ? "scrolled" : ""}`}>
        <button className="brand" onClick={() => navigate({ name: "home" })} aria-label="Kinly home">
          Kin<em>ly</em>
          {CHANNEL_LABEL && <span className="channel-badge">{CHANNEL_LABEL}</span>}
        </button>
        <nav className="topnav" aria-label="Main">
          {NAV.map((n) => (
            <button key={n.label} className={`topnav-item ${isActive(n) ? "active" : ""}`} onClick={() => navigate(n.route)}>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          <button className={`search-pill ${route.name === "search" ? "active" : ""}`} onClick={() => navigate({ name: "search", query: "" })}>
            <SearchIcon size={16} /> <span>Search</span> <kbd>/</kbd>
          </button>
          <button className={`icon-btn ${route.name === "addons" ? "active" : ""}`} onClick={() => navigate({ name: "addons" })} title="Addons" aria-label="Addons">
            <Puzzle size={19} />
          </button>
          <button className={`icon-btn ${route.name === "settings" ? "active" : ""}`} onClick={() => navigate({ name: "settings" })} title="Settings" aria-label="Settings">
            <SettingsIcon size={19} />
          </button>
          <button className="icon-btn" onClick={() => void toggleFullscreen()} title={fullscreen ? "Exit fullscreen (F11)" : "Fullscreen (F11)"} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
            {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
          </button>
          <ProfileSwitcher />
        </div>
      </header>
      <main className="main" key={JSON.stringify(route)} onScroll={onMainScroll}>
        {route.name === "home" && <Home />}
        {route.name === "browse" && <Browse type={route.type} />}
        {route.name === "search" && <Search initial={route.query} />}
        {route.name === "detail" && <Detail type={route.type} id={route.id} />}
        {route.name === "library" && <Library />}
        {route.name === "local" && <Downloads />}
        {route.name === "settings" && <SettingsView section={route.section} />}
        {route.name === "addons" && <AddonsView />}
      </main>
    </div>
  );
}
