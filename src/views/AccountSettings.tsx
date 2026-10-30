import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Cloud, Copy, ExternalLink, KeyRound, Link2, Loader2, LogOut, RefreshCw, Trash2, Unlink, UserRound, Users } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkPassword, showAuthScreen, showProfilePicker, updatePassword, useAccount } from "../lib/account";
import { deleteAccount, deleteAllCloudData, syncAndSignOut, syncNow, useSync } from "../lib/sync";
import {
  TRAKT_APPS_URL, TRAKT_REDIRECT, cancelTraktConnect, disconnectTrakt, forgetTraktApp, looksLikeTraktCredential, saveTraktApp,
  startTraktConnect, traktSyncNow, useTrakt,
} from "../lib/trakt";
import { FEATURES } from "../lib/features";
import { StrengthMeter } from "./Auth";
import { Avatar } from "./Profiles";

function Row({ label, help, children }: { label: string; help?: ReactNode; children?: ReactNode }) {
  return (
    <div className="setting">
      <div>
        <div className="setting-label">{label}</div>
        {help && <div className="setting-help">{help}</div>}
      </div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}

/** "x minutes ago" for status lines. */
export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString();
}

function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => set((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** Settings → Account: sign in/out, profiles, cloud sync status, password, delete cloud data. */
export function AccountSettings() {
  const account = useAccount();
  const sync = useSync();
  useTick();
  const [pwOpen, setPwOpen] = useState(false);
  const [deleting, setDeleting] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);

  if (account.status !== "signedIn") {
    return (
      <>
        <Row
          label="Kinly account"
          help="You're using Kinly as a guest: everything stays on this computer, with its own addons, library and connections. Sign in to get profiles, each with its own library and addons synced across devices."
        >
          <button className="btn primary" onClick={() => showAuthScreen(true)}><UserRound size={16} /> Sign in or create account</button>
        </Row>
      </>
    );
  }

  const del = async () => {
    setDeleting("busy");
    setError(null);
    try {
      await deleteAllCloudData();
      await syncAndSignOut();
    } catch (e) {
      setError(msg(e));
      setDeleting("idle");
    }
  };

  return (
    <>
      <Row label="Signed in" help={account.email ?? "Loading account details…"}>
        <button className="btn" onClick={() => void syncAndSignOut()}><LogOut size={16} /> Sign out</button>
      </Row>
      <Row
        label="Profile"
        help={sync.active ? <span className="acct-inline"><Avatar avatar={sync.active.avatar} size={20} /> {sync.active.name}</span> : "No profile selected"}
      >
        <button className="btn" onClick={() => showProfilePicker("manage")}><Users size={16} /> Manage profiles</button>
      </Row>
      <Row
        label="Cloud sync"
        help={
          <>
            Settings sync for the whole account; each profile's library and addons sync on their own. {FEATURES.trakt ? "Trakt and TMDB connections" : "TMDB keys"}
            belong to each profile and stay on this device. Volume, hardware decoding, interface size and local folders stay on this device too.
            <br />
            {account.offline ? "Offline — changes will sync when you're back online." : sync.busy ? "Syncing…" : `Last synced ${ago(sync.lastSync)}`}
            {sync.error && <span className="acct-error"> · {sync.error}</span>}
          </>
        }
      >
        <button className="btn" onClick={() => void syncNow()} disabled={sync.busy || !sync.active}>
          {sync.busy ? <Loader2 size={16} className="acct-spin" /> : <Cloud size={16} />} Sync now
        </button>
      </Row>
      <Row label="Password" help="Change the password for this account.">
        {!pwOpen && <button className="btn" onClick={() => setPwOpen(true)}><KeyRound size={16} /> Change password</button>}
      </Row>
      {pwOpen && <ChangePassword email={account.email} onDone={() => setPwOpen(false)} />}
      <Row
        label="Delete cloud data"
        help="Deletes every profile of this account with its library, and empties the synced addons and settings, then signs you out. The account itself stays. Your files on this computer are kept."
      >
        {deleting === "idle" && <button className="btn danger" onClick={() => setDeleting("confirm")}><Trash2 size={16} /> Delete…</button>}
        {deleting !== "idle" && (
          <>
            <button className="btn" onClick={() => setDeleting("idle")} disabled={deleting === "busy"}>Cancel</button>
            <button className="btn danger-solid" onClick={() => void del()} disabled={deleting === "busy"}>
              {deleting === "busy" ? <Loader2 size={16} className="acct-spin" /> : <Trash2 size={16} />} Delete everything
            </button>
          </>
        )}
      </Row>
      {error && <div className="auth-msg error" style={{ margin: "0 0 14px" }}>{error}</div>}
      <DeleteAccount />
    </>
  );
}

/** Settings → Account → Delete account: permanent, confirmed with the account password. */
function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(pw);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return (
    <>
      <Row
        label="Delete account"
        help="Permanently deletes your Kinly account and everything synced with it: profiles, libraries, addons, settings and PINs. This can't be undone. Files and the guest library on this computer are kept."
      >
        {!open && <button className="btn danger" onClick={() => setOpen(true)}><Trash2 size={16} /> Delete account…</button>}
      </Row>
      {open && (
        <form className="acct-box" onSubmit={(e) => { e.preventDefault(); if (pw && !busy) void run(); }}>
          <label className="auth-field">
            <span>Account password</span>
            <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" maxLength={128} disabled={busy} autoFocus />
          </label>
          {error && <div className="auth-msg error">{error}</div>}
          <div className="acct-actions">
            <button type="button" className="btn" onClick={() => { setOpen(false); setPw(""); setError(null); }} disabled={busy}>Cancel</button>
            <button className="btn danger-solid" disabled={!pw || busy}>
              {busy ? <Loader2 size={16} className="acct-spin" /> : <Trash2 size={16} />} Delete account permanently
            </button>
          </div>
        </form>
      )}
    </>
  );
}

function ChangePassword({ email, onDone }: { email?: string; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const check = useMemo(() => checkPassword(pw, email), [pw, email]);

  const save = async () => {
    if (pw !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await updatePassword(pw);
      setPw("");
      setConfirm("");
      setOk(true);
      window.setTimeout(onDone, 1500);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="acct-box" onSubmit={(e) => { e.preventDefault(); if (!busy) void save(); }}>
      <label className="auth-field">
        <span>New password</span>
        <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" maxLength={128} autoFocus />
      </label>
      <StrengthMeter score={check.score} problems={pw ? check.problems : []} />
      <label className="auth-field">
        <span>Confirm new password</span>
        <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={128} />
      </label>
      {error && <div className="auth-msg error">{error}</div>}
      {ok && <div className="auth-msg"><Check size={14} /> Password changed.</div>}
      <div className="acct-actions">
        <button type="button" className="btn" onClick={onDone} disabled={busy}>Cancel</button>
        <button className="btn primary" disabled={busy || !check.ok || !confirm}>
          {busy ? <Loader2 size={16} className="acct-spin" /> : null} Change password
        </button>
      </div>
    </form>
  );
}

/** Settings → Trakt: your own Trakt API app, device-code connect, import and status. */
export function TraktSettings() {
  const t = useTrakt();
  useTick();
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Put the code on the clipboard as soon as it appears, so it can be pasted on trakt.tv/activate.
  const shownCode = t.phase.kind === "code" ? t.phase.userCode : null;
  useEffect(() => {
    if (shownCode) void copy(shownCode);
  }, [shownCode]);

  if (!t.loaded) return <Row label="Trakt" help="Loading…" />;

  const saveApp = async () => {
    setError(null);
    try {
      await saveTraktApp(id, secret);
      setId("");
      setSecret("");
      setEditing(false);
    } catch (e) {
      setError(msg(e));
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const phase = t.phase;
  return (
    <>
      <Row
        label="Trakt"
        help="Import your Trakt watchlist and watched history into this profile's library, and let Trakt know what you watch in Kinly (scrobbling). Each profile connects its own Trakt account; the connection stays on this computer."
      />
      {editing ? (
        <div className="acct-box">
          <ol className="trakt-steps">
            <li>
              Open{" "}
              <button className="auth-link inline" onClick={() => void openUrl(TRAKT_APPS_URL)}>
                trakt.tv/oauth/applications <ExternalLink size={12} />
              </button>{" "}
              and choose <b>New application</b>.
            </li>
            <li>Name it (for example “Kinly”) and set the <b>Redirect URI</b> to <code>{TRAKT_REDIRECT}</code>. Leave the other fields empty, then save.</li>
            <li>Copy the <b>Client ID</b> and <b>Client Secret</b> it shows and paste them here. They stay on this computer.</li>
          </ol>
          <label className="auth-field">
            <span>Client ID</span>
            <input className="input mono" value={id} onChange={(e) => setId(e.target.value.trim())} spellCheck={false} autoComplete="off" maxLength={128} />
          </label>
          <label className="auth-field">
            <span>Client Secret</span>
            <input className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value.trim())} spellCheck={false} autoComplete="off" maxLength={128} />
          </label>
          {error && <div className="auth-msg error">{error}</div>}
          <div className="acct-actions">
            <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn primary" disabled={!looksLikeTraktCredential(id) || !looksLikeTraktCredential(secret)} onClick={() => void saveApp()}>
              <Check size={16} /> Save
            </button>
          </div>
        </div>
      ) : t.connected ? (
        <>
          <Row
            label="Connected"
            help={
              <>
                {t.syncing ? "Syncing with Trakt…" : `Last synced ${ago(t.lastSync)}`}
                {t.lastResult && !t.syncing && <> · {t.lastResult}</>}
                {t.error && <span className="acct-error"> · {t.error}</span>}
                <br />
                Kinly checks Trakt when it starts (at most every 15 minutes).
              </>
            }
          >
            <button className="btn" onClick={() => void traktSyncNow()} disabled={t.syncing}>
              {t.syncing ? <Loader2 size={16} className="acct-spin" /> : <RefreshCw size={16} />} Sync now
            </button>
            <button className="btn danger" onClick={() => void disconnectTrakt()}><Unlink size={16} /> Disconnect</button>
          </Row>
        </>
      ) : (
        <Row
          label="Connect your Trakt account"
          help={
            phase.kind === "code" ? undefined : (
              <>
                Click Connect, then sign in to Trakt in your browser and paste the code Kinly shows. No setup needed.
                {t.error && <span className="acct-error"> {t.error}</span>}
              </>
            )
          }
        >
          {phase.kind !== "code" && (
            <button className="btn primary" onClick={() => void startTraktConnect()} disabled={phase.kind === "requesting"}>
              {phase.kind === "requesting" ? <Loader2 size={16} className="acct-spin" /> : <Link2 size={16} />} Connect
            </button>
          )}
        </Row>
      )}
      {!editing && !t.connected && phase.kind === "code" && (
        <div className="trakt-code">
          <div className="trakt-code-label">Go to <b>{phase.url.replace(/^https:\/\//, "")}</b> and enter</div>
          <div className="trakt-code-value" aria-label="Trakt code">{phase.userCode}</div>
          <div className="acct-actions center">
            <button className="btn" onClick={() => void copy(phase.userCode)}>{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy code"}</button>
            <button className="btn primary" onClick={() => void openUrl(phase.url)}><ExternalLink size={16} /> Open trakt.tv/activate</button>
            <button className="btn ghost" onClick={cancelTraktConnect}>Cancel</button>
          </div>
          <div className="trakt-code-wait"><Loader2 size={14} className="acct-spin" /> Waiting for you to approve… The code expires at {new Date(phase.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</div>
        </div>
      )}
      {!editing && phase.kind === "error" && <div className="auth-msg error" style={{ margin: "0 0 14px" }}>{phase.message}</div>}
      {!editing && t.configured && (
        <Row label="Your own Trakt app" help={`Client ID ${t.clientId.slice(0, 6)}…`}>
          <button className="btn" onClick={() => setEditing(true)}>Change</button>
          <button className="btn ghost danger" onClick={() => void forgetTraktApp()}>Use Kinly's app</button>
        </Row>
      )}
      {!editing && !t.configured && !t.connected && (
        <button className="auth-link" style={{ margin: "4px 0 14px" }} onClick={() => setEditing(true)}>Advanced: use your own Trakt API app</button>
      )}
    </>
  );
}
