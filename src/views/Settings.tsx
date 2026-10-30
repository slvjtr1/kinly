import { CHANNEL_LABEL } from "../lib/channel";
import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, Captions, Check, Cpu, Info, KeyRound, Languages as LanguagesIcon, Library, Link2, Palette, PlayCircle, Plus, Puzzle,
  RotateCcw, Trash2, UserRound,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SUBTITLE_LANGUAGE_CHOICES, langName } from "../lib/lang";
import { DEFAULT_SETTINGS, DEFAULT_STYLE, QUALITY_LIMITS, SUBTITLE_FONTS, THEMES, isWindowsHost, recommendedPerformanceMode, rtxSuperResolutionSupport, type CreditsAction, type Settings, type SubStyle } from "../lib/settings";
import { ExternalPlayerSetting } from "../lib/extplayer";
import { useCaps } from "../lib/caps";
import { useAddons } from "../lib/useAddons";
import { appInfo, type AppInfo } from "../lib/tauri";
import { looksLikeTmdbKey, setTmdbKey, subscribeCredentials, testTmdbKey, tmdbKey } from "../lib/tmdb";
import { useApp } from "../state";
import { PrismHint, Switch, errorMessage } from "../components/ui";
import { AccountSettings, TraktSettings } from "./AccountSettings";

type SectionId = "appearance" | "playback" | "subtitles" | "languages" | "addons" | "connections" | "account" | "library" | "about";

const SECTIONS: { id: SectionId; label: string; icon: typeof Palette; group?: string }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "playback", label: "Playback", icon: PlayCircle },
  { id: "subtitles", label: "Subtitles", icon: Captions },
  { id: "languages", label: "Languages", icon: LanguagesIcon },
  { id: "addons", label: "Addons", icon: Puzzle, group: "Sources" },
  { id: "connections", label: "Connections", icon: Link2 },
  { id: "account", label: "Account & profiles", icon: UserRound, group: "Account" },
  { id: "library", label: "Library", icon: Library },
  { id: "about", label: "About", icon: Info, group: "Kinly" },
];

export default function SettingsView({ section }: { section?: string }) {
  const initial = section === "trakt" ? "connections" : (SECTIONS.find((x) => x.id === section)?.id ?? (section === "application" ? "about" : "appearance"));
  const [active, setActive] = useState<SectionId>(initial);
  const current = SECTIONS.find((x) => x.id === active)!;
  return (
    <div className="page settings-page">
      <h1 className="page-title">Settings</h1>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(({ id, label, icon: Icon, group }) => (
            <Fragment key={id}>
              {group && <div className="nav-group">{group}</div>}
              <button className={`nav-item ${active === id ? "active" : ""}`} aria-current={active === id ? "page" : undefined} onClick={() => setActive(id)}>
                <Icon size={17} /> {label}
              </button>
            </Fragment>
          ))}
        </nav>
        <section className="settings-body" key={active} aria-label={current.label}>
          <h2 className="settings-heading">{current.label}</h2>
          <div className="panel settings-panel">
            {active === "appearance" && <Appearance />}
            {active === "playback" && <Playback />}
            {active === "subtitles" && <Subtitles />}
            {active === "languages" && <Languages />}
            {active === "library" && <LibrarySection />}
            {active === "addons" && <AddonsSection />}
            {active === "connections" && <Connections />}
            {active === "account" && <AccountSettings />}
            {active === "about" && <About />}
          </div>
        </section>
      </div>
    </div>
  );
}

function Row({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div>
        <div className="setting-label">{label}</div>
        {help && <div className="setting-help">{help}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function useSection<K extends keyof Settings>(key: K) {
  const { settings, update } = useApp();
  const value = settings[key];
  const set = (patch: Partial<Settings[K]>) => update((s) => ({ ...s, [key]: { ...(s[key] as object), ...patch } }));
  return [value, set] as const;
}

function Appearance() {
  const [a, set] = useSection("appearance");
  const caps = useCaps();
  const recMode = recommendedPerformanceMode(caps);
  const recLabel = `Auto (${recMode.charAt(0).toUpperCase() + recMode.slice(1)} on this device)`;
  return (
    <>
      <div className="setting setting-block">
        <div>
          <div className="setting-label">Theme</div>
          <div className="setting-help">Ocean is the default. OLED uses true black, which saves power on OLED screens.</div>
        </div>
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.id} role="radio" aria-checked={a.theme === t.id} className={`theme-card ${a.theme === t.id ? "active" : ""}`} onClick={() => set({ theme: t.id })}>
              <span className="theme-swatch" style={{ background: t.swatch[0] }}>
                <i style={{ background: t.swatch[1] }} />
                <i style={{ background: t.swatch[1] }} />
                <b style={{ background: t.swatch[2] }} />
              </span>
              <span className="theme-name">{t.name}{a.theme === t.id && <Check size={14} />}</span>
            </button>
          ))}
        </div>
      </div>
      <Row label="Performance mode" help="Controls blur filters and interface transitions. Auto chooses the recommended mode based on your device capabilities.">
        <select
          className="select"
          value={a.performanceMode}
          onChange={(e) => set({ performanceMode: e.target.value as Settings["appearance"]["performanceMode"] })}
          aria-label="Performance mode"
        >
          <option value="auto">{recLabel}</option>
          <option value="maximum">Maximum (full blurs & animations)</option>
          <option value="balanced">Balanced (smooth scroll)</option>
          <option value="performance">Performance (minimal effects)</option>
        </select>
      </Row>
      <Row label="Interface size" help="Scales the whole interface for your display.">
        <input type="range" min={0.8} max={1.5} step={0.05} value={a.uiScale} onChange={(e) => set({ uiScale: Number(e.target.value) })} aria-label="Interface size" />
        <span className="range-value">{Math.round(a.uiScale * 100)}%</span>
      </Row>
      <Row label="Reduce motion" help="Turns off hover lifts and animated transitions. Kinly also follows your system's reduced-motion setting.">
        <Switch checked={a.reduceMotion} onChange={(v) => set({ reduceMotion: v })} label="Reduce motion" />
      </Row>
    </>
  );
}

function SubtitlePreview({ st }: { st: SubStyle }) {
  const rgba = (hex: string, a: number) => `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
  const o = st.background || !st.outlineOn ? 0 : st.outline * 0.6;
  const outline = o > 0 ? [...Array(16)].map((_, i) => `${(Math.cos((i / 16) * 2 * Math.PI) * o).toFixed(2)}px ${(Math.sin((i / 16) * 2 * Math.PI) * o).toFixed(2)}px 0 ${st.outlineColor}`) : [];
  const shadow = !st.background && st.shadow > 0 ? [`${st.shadow * 0.8}px ${st.shadow * 0.8}px 0 ${rgba(st.shadowColor, st.shadowOpacity)}`] : [];
  const line = {
    fontFamily: `"${st.font}", "Noto Sans", sans-serif`,
    fontWeight: st.bold ? 700 : 400,
    fontSize: st.size * 0.42,
    color: rgba(st.color, st.opacity),
    textShadow: [...outline, ...shadow].join(", ") || "none",
    background: st.background ? rgba(st.backgroundColor, st.backgroundOpacity) : "transparent",
    padding: st.background ? "1px 8px" : 0,
    lineHeight: 1.35,
  } as const;
  return (
    <div className="sub-preview" style={{ paddingBottom: 10 + (100 - st.position) * 1.1 }}>
      <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <span dir="auto" style={line}>قالَ لي: «هل شاهدتَ الحلقة ٣ على Netflix؟»</span>
        <span dir="auto" style={line}>Yes — twice, with 2 friends!</span>
      </div>
    </div>
  );
}

function Subtitles() {
  const [s, set] = useSection("subtitles");
  const st = s.style;
  const setStyle = (patch: Partial<SubStyle>) => set({ style: { ...st, ...patch } });
  return (
    <>
      <Row label="Auto Select" help="Pick the best-matching subtitle when playback starts, using your language order, the episode, the release name and the subtitle's real text. A choice you make yourself is never overridden.">
        <Switch checked={s.autoSelect} onChange={(v) => set({ autoSelect: v })} label="Auto Select" />
      </Row>
      <Row label="Auto Sync" help="Align downloaded and external subtitles to the dialogue by analysing a few short audio windows on this computer. Nothing is uploaded. Embedded subtitles are left as they are.">
        <Switch checked={s.autoSync} onChange={(v) => set({ autoSync: v })} label="Auto Sync" />
      </Row>
      <Row label="Avoid SDH subtitles" help="Prefer subtitles without sound descriptions ([door creaks]) when both exist.">
        <Switch checked={s.avoidSdh} onChange={(v) => set({ avoidSdh: v })} label="Avoid SDH" />
      </Row>
      <div style={{ padding: "14px 0" }}>
        <SubtitlePreview st={st} />
        <p className="faint" style={{ fontSize: 12, margin: "6px 0 0" }}>Preview is approximate; the player renders with the same fonts through libass. Size, bold and the background box can also be changed from the subtitle panel while watching.</p>
      </div>
      <Row label="Font">
        <select className="select" value={st.font} onChange={(e) => setStyle({ font: e.target.value })} aria-label="Font">
          {SUBTITLE_FONTS.map((f) => <option key={f.family} value={f.family}>{f.label}</option>)}
        </select>
      </Row>
      <Row label="Bold"><Switch checked={st.bold} onChange={(v) => setStyle({ bold: v })} label="Bold" /></Row>
      <Row label="Size">
        <input type="range" min={30} max={90} value={st.size} onChange={(e) => setStyle({ size: Number(e.target.value) })} aria-label="Size" />
        <span className="range-value">{st.size}</span>
      </Row>
      <Row label="Text colour and opacity">
        <input type="color" value={st.color} onChange={(e) => setStyle({ color: e.target.value })} aria-label="Text colour" />
        <input type="range" min={0.2} max={1} step={0.05} value={st.opacity} onChange={(e) => setStyle({ opacity: Number(e.target.value) })} aria-label="Text opacity" />
      </Row>
      <Row label="Outline" help={st.background ? "Not used while the background box is on." : undefined}>
        <input type="color" value={st.outlineColor} onChange={(e) => setStyle({ outlineColor: e.target.value })} aria-label="Outline colour" disabled={st.background || !st.outlineOn} />
        <input type="range" min={0} max={6} step={0.5} value={st.outline} onChange={(e) => setStyle({ outline: Number(e.target.value) })} aria-label="Outline size" disabled={st.background || !st.outlineOn} />
        <span className="range-value">{st.outline}</span>
        <Switch checked={st.outlineOn} onChange={(v) => setStyle({ outlineOn: v })} label="Outline" />
      </Row>
      <Row label="Shadow" help={st.background ? "Not used while the background box is on." : "Colour, strength and distance."}>
        <input type="color" value={st.shadowColor} onChange={(e) => setStyle({ shadowColor: e.target.value })} aria-label="Shadow colour" disabled={st.background} />
        <input type="range" min={0} max={1} step={0.05} value={st.shadowOpacity} onChange={(e) => setStyle({ shadowOpacity: Number(e.target.value) })} aria-label="Shadow strength" style={{ width: 100 }} disabled={st.background} />
        <input type="range" min={0} max={6} step={0.5} value={st.shadow} onChange={(e) => setStyle({ shadow: Number(e.target.value) })} aria-label="Shadow distance" style={{ width: 100 }} disabled={st.background} />
      </Row>
      <Row label="Background box" help="A solid box behind the text for maximum readability.">
        <input type="color" value={st.backgroundColor} onChange={(e) => setStyle({ backgroundColor: e.target.value })} aria-label="Box colour" />
        <input type="range" min={0.1} max={1} step={0.05} value={st.backgroundOpacity} onChange={(e) => setStyle({ backgroundOpacity: Number(e.target.value) })} aria-label="Box opacity" style={{ width: 100 }} />
        <Switch checked={st.background} onChange={(v) => setStyle({ background: v })} label="Background box" />
      </Row>
      <Row label="Vertical position" help="100 is the bottom of the picture.">
        <input type="range" min={50} max={100} value={st.position} onChange={(e) => setStyle({ position: Number(e.target.value) })} aria-label="Vertical position" />
        <span className="range-value">{st.position}</span>
      </Row>
      <Row label="Apply style to styled (ASS) subtitles" help="Off keeps the author's styling for anime/karaoke subtitles; on forces your font and colours everywhere.">
        <Switch checked={st.overrideAss} onChange={(v) => setStyle({ overrideAss: v })} label="Override ASS styles" />
      </Row>
      <Row label="Reset subtitle style">
        <button className="btn" onClick={() => set({ style: DEFAULT_STYLE })}><RotateCcw size={16} /> Reset</button>
      </Row>
    </>
  );
}

const CREDITS_LABEL: Record<CreditsAction, string> = { button: "Show “Next episode” button", auto: "Play next episode automatically", off: "Do nothing" };

function Playback() {
  const [p, set] = useSection("playback");
  const caps = useCaps();
  const auto = caps?.recommendedMaxHeight ? `Auto (this device: up to ${caps.recommendedMaxHeight}p)` : "Auto (by device)";
  const rtx = rtxSuperResolutionSupport(caps, isWindowsHost());
  return (
    <>
      <ExternalPlayerSetting />
      <Row label="Resume where you left off"><Switch checked={p.resume} onChange={(v) => set({ resume: v })} label="Resume" /></Row>
      <Row label="Skip intros & recaps automatically" help="Uses IntroDB timestamps when a title has them. When off, a Skip button appears instead.">
        <Switch checked={p.skipIntro} onChange={(v) => set({ skipIntro: v })} label="Skip intros and recaps automatically" />
      </Row>
      <Row label="When the credits start" help="For episodes with a next episode. Movies show a Skip credits button.">
        <select className="select" value={p.credits} onChange={(e) => set({ credits: e.target.value as CreditsAction })} aria-label="When the credits start">
          {(Object.keys(CREDITS_LABEL) as CreditsAction[]).map((k) => <option key={k} value={k}>{CREDITS_LABEL[k]}</option>)}
        </select>
      </Row>
      <Row label="Play next episode at the end" help="Uses the same source group when the addon provides one."><Switch checked={p.autoplayNext} onChange={(v) => set({ autoplayNext: v })} label="Autoplay next" /></Row>
      <Row label="Quality limit" help="Best match prefers the highest quality this device plays smoothly. Sources above the limit are listed last, marked “May stutter”.">
        <select className="select" value={String(p.qualityLimit)} onChange={(e) => set({ qualityLimit: e.target.value === "auto" ? "auto" : (Number(e.target.value) as Settings["playback"]["qualityLimit"]) })} aria-label="Quality limit">
          {QUALITY_LIMITS.map((q) => <option key={q} value={String(q)}>{q === "auto" ? auto : q === 2160 ? "4K (2160p)" : `${q}p`}</option>)}
        </select>
      </Row>
      <Row label="Hardware decoding" help={<>Uses the GPU when it is safe to do so. Turn off if you see corrupted video.{caps && <DecodeSupport caps={caps} />}</>}>
        <Switch checked={p.hwdec} onChange={(v) => set({ hwdec: v })} label="Hardware decoding" />
      </Row>
      {rtx === "available" && (
        <Row
          label="RTX Video Super Resolution"
          help="Upscales video below your display's resolution with the NVIDIA AI upscaler. Needs hardware decoding and RTX Video enhancement turned on in the NVIDIA app. Takes effect from the next video."
        >
          <Switch checked={p.rtxSuperResolution} onChange={(v) => set({ rtxSuperResolution: v })} label="RTX Video Super Resolution" />
        </Row>
      )}
      {rtx === "unavailable" && (
        <Row label="RTX Video Super Resolution" help="Available on Windows (NVIDIA driver limitation).">
          <button className="switch" role="switch" aria-checked={false} aria-label="RTX Video Super Resolution" aria-disabled disabled style={{ opacity: 0.45, cursor: "not-allowed" }} />
        </Row>
      )}
      <Row label="Seek step (← / →)">
        <select className="select" value={p.seekStep} onChange={(e) => set({ seekStep: Number(e.target.value) })} aria-label="Seek step">
          {[5, 10, 15, 30].map((s) => <option key={s} value={s}>{s} seconds</option>)}
        </select>
      </Row>
      <Row label="Starting volume">
        <input type="range" min={0} max={130} value={p.volume} onChange={(e) => set({ volume: Number(e.target.value) })} aria-label="Starting volume" />
        <span className="range-value">{p.volume}%</span>
      </Row>
    </>
  );
}

function DecodeSupport({ caps }: { caps: NonNullable<ReturnType<typeof useCaps>> }) {
  const codecs: [keyof typeof caps.hwdec, string][] = [["h264", "H.264"], ["hevc", "HEVC"], ["hevc10", "HEVC 10-bit"], ["vp9", "VP9"], ["av1", "AV1"]];
  return (
    <span className="decode-support">
      <Cpu size={13} /> {caps.hwdecApi || "GPU"}:
      {codecs.map(([k, label]) => <span key={k} className={`badge ${caps.hwdec[k] ? "ok" : ""}`}>{label}</span>)}
    </span>
  );
}

function AddonsSection() {
  const { navigate } = useApp();
  const { addons } = useAddons();
  return (
    <Row label="Addons" help={`Stremio addons provide catalogs, streams and subtitles. ${addons.length} installed.`}>
      <button className="btn primary" onClick={() => navigate({ name: "addons" })}><Puzzle size={16} /> Manage addons</button>
    </Row>
  );
}

function LangOrder({ value, onChange, empty }: { value: string[]; onChange: (v: string[]) => void; empty: string }) {
  const [adding, setAdding] = useState("");
  const move = (i: number, d: number) => {
    const v = [...value];
    [v[i], v[i + d]] = [v[i + d], v[i]];
    onChange(v);
  };
  return (
    <div className="lang-list">
      {value.length === 0 && <div className="faint">{empty}</div>}
      {value.map((code, i) => (
        <div key={code} className="lang-item">
          <b>{i + 1}</b>
          <span>{langName(code)}</span>
          <button className="btn icon ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp size={16} /></button>
          <button className="btn icon ghost" disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown size={16} /></button>
          <button className="btn icon ghost" onClick={() => onChange(value.filter((c) => c !== code))} aria-label="Remove"><Trash2 size={16} /></button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <select className="select" style={{ flex: 1 }} value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add language">
          <option value="">Add a language…</option>
          {SUBTITLE_LANGUAGE_CHOICES.filter((l) => !value.includes(l.code)).map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <button className="btn" disabled={!adding} onClick={() => { onChange([...value, adding]); setAdding(""); }}><Plus size={16} /> Add</button>
      </div>
    </div>
  );
}

function Languages() {
  const { settings, update } = useApp();
  return (
    <>
      <Row label="Subtitle languages" help="In order of preference. Auto Select only considers these languages. A well-matched subtitle in your first language always wins over the second; a wrong-episode or mislabeled one is skipped.">
        <LangOrder value={settings.subtitles.languages} onChange={(v) => update((s) => ({ ...s, subtitles: { ...s.subtitles, languages: v } }))} empty="No languages: Auto Select will not choose anything." />
      </Row>
      <Row label="Audio languages" help="Preferred audio tracks for files with several languages. Empty keeps the file's default.">
        <LangOrder value={settings.playback.audioLanguages} onChange={(v) => update((s) => ({ ...s, playback: { ...s.playback, audioLanguages: v } }))} empty="File default" />
      </Row>
      <Row label="Interface language" help="Kinly's interface is in English."><span className="muted">English</span></Row>
    </>
  );
}

function Connections() {
  useSyncExternalStore(subscribeCredentials, tmdbKey);
  const key = tmdbKey();
  const { toast } = useApp();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connect = async () => {
    const k = input.trim();
    setErr(null);
    if (!looksLikeTmdbKey(k)) return setErr("That does not look like a TMDB API key (32 characters) or API Read Access Token (starts with eyJ).");
    setBusy(true);
    try {
      await testTmdbKey(k);
      await setTmdbKey(k);
      setInput("");
      toast("TMDB connected");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row
        label="TMDB"
        help={<>Adds “More like this” recommendations to title pages. Use your own free key from <a href="#" onClick={(e) => { e.preventDefault(); void openUrl("https://www.themoviedb.org/settings/api"); }}>themoviedb.org/settings/api</a>. The key is stored only on this computer (readable by your user only) and sent only to api.themoviedb.org.</>}
      >
        {key ? (
          <>
            <span className="badge ok"><KeyRound size={13} /> Connected · ••••{key.slice(-4)}</span>
            <button className="btn" onClick={() => void setTmdbKey(null).then(() => toast("TMDB disconnected"))}>Disconnect</button>
          </>
        ) : (
          <span className="badge">Not connected</span>
        )}
      </Row>
      {!key && (
        <div style={{ padding: "4px 0 16px" }}>
          <div className="input-row">
            <input className="input" type="password" autoComplete="off" spellCheck={false} placeholder="TMDB API key or Read Access Token" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && input && void connect()} aria-label="TMDB API key" />
            <button className="btn primary" disabled={!input || busy} onClick={() => void connect()}>{busy ? "Checking…" : "Connect"}</button>
          </div>
          {err && <p className="error-text">{err}</p>}
        </div>
      )}
      <TraktSettings />
    </>
  );
}

function LibrarySection() {
  const [l, set] = useSection("library");
  return (
    <>
      <Row label="Mark as watched after" help="Progress beyond this point counts as watched and leaves Continue watching.">
        <select className="select" value={l.watchedThreshold} onChange={(e) => set({ watchedThreshold: Number(e.target.value) })} aria-label="Watched threshold">
          {[0.8, 0.85, 0.9, 0.95].map((v) => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}
        </select>
      </Row>
      <Row label="Download outside Kinly" help={<>Off: Kinly saves downloads to your Downloads folder and shows their progress on the Downloads page. On: the link opens in your browser and is copied, for your own download manager <PrismHint />.</>}>
        <Switch checked={l.downloadExternally} onChange={(v) => set({ downloadExternally: v })} label="Download outside Kinly" />
      </Row>
    </>
  );
}

function About() {
  const { update, toast } = useApp();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => void appInfo().then(setInfo).catch(() => setInfo(null)), []);
  const shortcuts: [string, string][] = [
    ["Space / K", "Play / pause"], ["← / →", "Seek (Shift: 60 s)"], ["↑ / ↓", "Volume"], ["M", "Mute"], ["F / double-click", "Fullscreen"],
    ["S", "Subtitles panel"], ["A", "Audio panel"], ["Z / X", "Subtitle delay −/+ 0.1 s"], ["N", "Next episode"], ["Esc", "Close panel / exit fullscreen / back"],
    ["Ctrl+K or /", "Search"],
  ];
  return (
    <>
      <Row label="Version"><span className="muted">Kinly {info?.version ?? "…"}{CHANNEL_LABEL ? ` ${CHANNEL_LABEL}` : ""}</span></Row>
      <Row label="Auto Sync audio analysis" help="Needs ffmpeg on this system.">
        <span className={`badge ${info?.ffmpeg ? "ok" : "warn"}`}>{info ? (info.ffmpeg ? "ffmpeg available" : "ffmpeg missing") : "…"}</span>
      </Row>
      <Row label="Data folders" help={<>Settings: {info?.configDir}<br />Cache: {info?.cacheDir}<br />Library: {info?.dataDir}<br />Logs: {info?.logDir}</>}><span /></Row>
      <Row label="Privacy" help="No telemetry or analytics. Network requests go only to the addons you install, their artwork servers, the subtitle sources they return, IntroDB for skip timestamps, and TMDB if you connect it. Audio analysis for Auto Sync runs locally."><span /></Row>
      <div style={{ padding: "14px 0" }}>
        <div className="setting-label" style={{ marginBottom: 8 }}>Keyboard shortcuts</div>
        <div className="shortcut-grid">
          {shortcuts.map(([k, d]) => (
            <Fragment key={k}>
              <span><span className="kbd">{k}</span></span>
              <span className="muted">{d}</span>
            </Fragment>
          ))}
        </div>
      </div>
      <Row label="Reset all settings" help="Restores defaults for appearance, subtitles, playback and languages. Your library, addons and history are kept.">
        {confirm ? (
          <>
            <button className="btn danger" onClick={() => { update((s) => ({ ...DEFAULT_SETTINGS, library: { ...DEFAULT_SETTINGS.library, folders: s.library.folders } })); setConfirm(false); toast("Settings reset"); }}>Reset</button>
            <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
          </>
        ) : (
          <button className="btn" onClick={() => setConfirm(true)}><RotateCcw size={16} /> Reset…</button>
        )}
      </Row>
      <Row label="Licenses" help="Kinly is MIT licensed and includes code adapted from Compass (MIT) and Noto fonts (SIL OFL 1.1).">
        <button className="btn ghost" onClick={() => void openUrl("https://github.com/compassstremio/Compass")}>Compass</button>
      </Row>
    </>
  );
}
