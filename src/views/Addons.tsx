import { useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Puzzle, Trash2 } from "lucide-react";
import { CINEMETA, OPENSUBTITLES, type Addon } from "../lib/addons";
import { installAddon, moveAddon, removeAddon, useAddons } from "../lib/useAddons";
import { useApp } from "../state";
import { Modal, errorMessage } from "../components/ui";

export default function AddonsView() {
  return (
    <div className="page">
      <h1 className="page-title">Addons</h1>
      <AddonList />
    </div>
  );
}

function AddonList() {
  const { addons, status } = useAddons();
  const { toast } = useApp();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Addon | null>(null);

  const install = async (input = url) => {
    setBusy(true);
    setErr(null);
    try {
      const a = await installAddon(input);
      toast(`Installed ${a.manifest.name}`);
      setUrl("");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = (a: Addon) => (a.transportUrl === CINEMETA ? setConfirm(a) : void removeAddon(a.transportUrl));
  const resources = (a: Addon) => a.manifest.resources.map((r) => (typeof r === "string" ? r : r.name)).filter((r) => ["catalog", "meta", "stream", "subtitles"].includes(r));

  return (
    <>
      <div className="panel install-panel">
        <div className="setting-label">Install an addon</div>
        <div className="setting-help" style={{ marginBottom: 12 }}>
          Paste a Stremio addon manifest URL (https://…/manifest.json or stremio://…). Addons are made by third parties; you are responsible for the sources you add and their terms. Kinly plays direct HTTP streams; torrent-only results need a debrid-enabled addon.
        </div>
        <div className="input-row">
          <input className="input" placeholder="https://example.com/manifest.json" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && url && void install()} aria-label="Addon URL" />
          <button className="btn primary" disabled={!url || busy} onClick={() => void install()}>{busy ? "Installing…" : "Install"}</button>
        </div>
        {err && <p className="error-text">{err}</p>}
        {status !== "loading" && !addons.some((a) => a.transportUrl === CINEMETA) && (
          <p className="notice warn">
            <AlertTriangle size={16} /> Cinemeta is not installed, so Home, Movies, Series and Search have no catalogs.
            <button className="btn small" disabled={busy} onClick={() => void install(CINEMETA)}>Reinstall Cinemeta</button>
          </p>
        )}
      </div>

      {status === "loading" && <p className="muted">Loading addons…</p>}
      <div className="item-list">
        {addons.map((a, i) => (
          <div key={a.transportUrl} className="item">
            <AddonIcon logo={a.manifest.logo} />
            <div className="item-main">
              <div className="item-title">
                {a.manifest.name} <span className="faint">v{a.manifest.version}</span>
                {(a.transportUrl === CINEMETA || a.transportUrl === OPENSUBTITLES) && <span className="badge accent">Default</span>}
              </div>
              <div className="item-sub">{a.manifest.description ?? ""}</div>
              <div className="item-tags">{resources(a).map((r) => <span key={r} className="badge">{r}</span>)}</div>
            </div>
            <div className="item-actions">
              <button className="icon-btn" disabled={i === 0} onClick={() => void moveAddon(a.transportUrl, -1)} aria-label="Move up"><ArrowUp size={17} /></button>
              <button className="icon-btn" disabled={i === addons.length - 1} onClick={() => void moveAddon(a.transportUrl, 1)} aria-label="Move down"><ArrowDown size={17} /></button>
              <button className="icon-btn danger" onClick={() => remove(a)} aria-label={`Remove ${a.manifest.name}`}><Trash2 size={17} /></button>
            </div>
          </div>
        ))}
      </div>
      <p className="faint" style={{ fontSize: 12 }}>Order matters: metadata comes from the first addon that has it, and Home rows follow this order.</p>

      {confirm && (
        <Modal
          title="Remove Cinemeta?"
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>Keep Cinemeta</button>
              <button className="btn danger-solid" onClick={() => { void removeAddon(confirm.transportUrl); setConfirm(null); toast("Cinemeta removed"); }}>Remove anyway</button>
            </>
          }
        >
          <p className="notice warn"><AlertTriangle size={18} /> Cinemeta provides Kinly's catalogs, search and title details.</p>
          <p className="muted">Without it, Home, Movies, Series and Search will be empty and title pages will not load unless another installed addon provides the same data. You can reinstall it from this page at any time.</p>
        </Modal>
      )}
    </>
  );
}

function AddonIcon({ logo }: { logo?: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="item-icon">{logo && !failed ? <img src={logo} alt="" onError={() => setFailed(true)} /> : <Puzzle size={22} />}</div>;
}
