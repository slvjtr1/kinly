import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ImageIcon, Link2, Loader2, LogOut, Pencil, Plus, Settings as SettingsIcon, Trash2, UserRound, Users, X } from "lucide-react";
import { AVATAR_URL_MAX, isAvatarUrl, showAuthScreen, showProfilePicker, useAccount } from "../lib/account";
import { PIN_MAX, pinInput, pinMessage, pinOk, verifyPin } from "../lib/pins";
import { createProfileWithOptions, needsPrimaryPin } from "../lib/profileCreate";
import {
  MAX_PROFILES, clearPinPrompt, deleteProfile, primaryProfile, updateProfile, profileNameOk, refreshProfiles, selectProfile, syncAndSignOut, useSync,
  type Profile,
} from "../lib/sync";
import { useApp } from "../state";
import { AVATAR_ART, AVATAR_CATEGORIES, AvatarSvg, DEFAULT_AVATAR, avatarArt, avatarCategory, type AvatarCategory } from "./avatars";
import { HOUSEHOLD_NOTE, LockBadge, NewPinFields, PinPad, PinSettings } from "./PinPad";
import "../styles/library.css";
import "../styles/profiles.css";

/** Built-in avatar keys, in picker order. */
export const AVATARS = AVATAR_ART.map((a) => a.key);

/**
 * A profile avatar: a built-in character (legacy emoji keys map to one), or an image link. Image
 * links load lazily without a referrer and fall back to the default character if they fail.
 */
export function Avatar({ avatar, size = 40 }: { avatar: string; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = isAvatarUrl(avatar);
  return (
    <span className="avatar avatar-art" style={{ width: size, height: size }} aria-hidden="true">
      {url && failed !== avatar ? (
        <img src={avatar} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(avatar)} />
      ) : (
        <AvatarSvg avatarKey={url ? DEFAULT_AVATAR : avatar} />
      )}
    </span>
  );
}

const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** "Who's watching?" — pick, add, edit and delete profiles. `onClose` is set when opened from the app. */
export default function Profiles({ manage: startManage = false, onClose }: { manage?: boolean; onClose?: () => void }) {
  const sync = useSync();
  const [manage, setManage] = useState(startManage);
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<Profile | null>(null);
  // At launch the last profile opens by itself; with a PIN, its pad opens here instead.
  const prompted = sync.pinPrompt && !manage ? sync.profiles.find((p) => p.id === sync.pinPrompt) ?? null : null;
  const pad = pinFor ?? prompted;

  useEffect(() => {
    void refreshProfiles().catch(() => {});
  }, []);

  useEffect(() => {
    if (!onClose || editing || pad) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editing, pad]);

  const empty = sync.profilesLoaded && sync.profiles.length === 0;
  const showEditor = editing ?? (empty ? "new" : null);

  const open = async (p: Profile, pinVerified = false) => {
    setBusyId(p.id);
    setError(null);
    try {
      await selectProfile(p, { pinVerified });
      setPinFor(null);
      showProfilePicker(false);
      onClose?.();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusyId(null);
    }
  };
  const pick = async (p: Profile) => {
    if (manage) return setEditing(p);
    setNotice(null);
    if (sync.pins[p.id] && sync.active?.id !== p.id) return setPinFor(p);
    await open(p);
  };
  const closePad = () => {
    setPinFor(null);
    clearPinPrompt();
  };

  return (
    <div className="profiles-screen" role="dialog" aria-modal="true" aria-label="Who's watching?">
      <div className="auth-bg" aria-hidden="true">
        <div className="auth-orb a" />
        <div className="auth-orb b" />
      </div>
      {onClose && sync.active && (
        <button className="icon-btn auth-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
      )}
      {showEditor ? (
        <ProfileEditor
          profile={showEditor === "new" ? null : showEditor}
          first={empty}
          hasPin={showEditor !== "new" && !!sync.pins[showEditor.id]}
          onDone={(created, warning) => {
            setEditing(null);
            setNotice(warning ?? null);
            if (created && empty) void open(created, true);
          }}
        />
      ) : (
        <div className="profiles-inner">
          <div className="wordmark small"><span className="kin">Kin</span><span className="ly">ly</span></div>
          <h1>{manage ? "Manage profiles" : "Who's watching?"}</h1>
          {!sync.profilesLoaded && sync.profiles.length === 0 ? (
            <div className="profiles-loading"><Loader2 className="acct-spin" size={28} /></div>
          ) : (
            <div className="profile-grid">
              {sync.profiles.map((p) => (
                <button key={p.id} className={`profile-tile ${manage ? "manage" : ""} ${sync.active?.id === p.id ? "current" : ""}`} onClick={() => void pick(p)} disabled={!!busyId}>
                  <span className="profile-face">
                    <Avatar avatar={p.avatar} size={112} />
                    {sync.pins[p.id] && <LockBadge size={16} />}
                    {manage && <span className="profile-edit"><Pencil size={26} /></span>}
                    {busyId === p.id && <span className="profile-edit"><Loader2 className="acct-spin" size={26} /></span>}
                  </span>
                  <span className="profile-name">{p.name}</span>
                </button>
              ))}
              {sync.profiles.length < MAX_PROFILES && (
                <button className="profile-tile add" onClick={() => setEditing("new")}>
                  <span className="profile-face"><span className="avatar add"><Plus size={44} /></span></span>
                  <span className="profile-name">Add profile</span>
                </button>
              )}
            </div>
          )}
          {(error || sync.error) && <div className="auth-msg error">{error ?? sync.error}</div>}
          {notice && <div className="auth-msg error">{notice}</div>}
          <div className="profiles-actions">
            <button className={`btn ${manage ? "primary" : "glass"}`} onClick={() => setManage(!manage)}>
              {manage ? <><Check size={16} /> Done</> : <><Pencil size={16} /> Manage profiles</>}
            </button>
            <button className="btn ghost" onClick={() => void syncAndSignOut()}><LogOut size={16} /> Sign out</button>
          </div>
        </div>
      )}
      {pad && !showEditor && <PinPad key={pad.id} profile={pad} onCancel={closePad} onOk={() => open(pad, true)} />}
    </div>
  );
}

function ProfileEditor({ profile, first, hasPin, onDone }: { profile: Profile | null; first: boolean; hasPin: boolean; onDone: (created?: Profile, warning?: string) => void }) {
  const sync = useSync();
  const primary = profile ? null : primaryProfile();
  const primaryLocked = !!primary && !!sync.pins[primary.id];
  const [copyAddons, setCopyAddons] = useState(true);
  const [copyConnections, setCopyConnections] = useState(false);
  const [primaryPin, setPrimaryPin] = useState("");
  const [usePin, setUsePin] = useState(false);
  const [newPin, setNewPin] = useState<string | null>(null);
  const [deletePin, setDeletePin] = useState("");
  const onNewPin = useCallback((p: string | null) => setNewPin(p), []);
  const needPrimaryPin = primaryLocked && needsPrimaryPin({ copyAddons, copyConnections });
  const [name, setName] = useState(profile?.name ?? "");
  const [avatar, setAvatar] = useState(profile?.avatar ?? DEFAULT_AVATAR);
  const startsWithLink = !!profile && isAvatarUrl(profile.avatar);
  const [linkMode, setLinkMode] = useState(startsWithLink);
  const [link, setLink] = useState(startsWithLink ? profile!.avatar : "");
  const [linkState, setLinkState] = useState<"idle" | "invalid" | "loading" | "ok" | "error">(startsWithLink ? "loading" : "idle");
  const linkBlocks = isAvatarUrl(avatar) && linkState !== "ok";
  const currentCat: AvatarCategory | null = isAvatarUrl(avatar) ? null : avatarCategory(avatarArt(avatar));
  const [cat, setCat] = useState<AvatarCategory>(currentCat ?? "classics");

  const onLink = (raw: string) => {
    const v = raw.trim().slice(0, AVATAR_URL_MAX + 1);
    setLink(v);
    if (!v) {
      setLinkState("idle");
      return;
    }
    if (!isAvatarUrl(v)) {
      setLinkState("invalid");
      return;
    }
    setLinkState("loading");
    setAvatar(v);
  };
  const pickBuiltIn = (key: string) => {
    setAvatar(key);
    setLinkMode(false);
  };
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (profile) {
        await updateProfile(profile.id, name, avatar);
        onDone();
        return;
      }
      if (usePin && !newPin) throw new Error("Enter the new PIN twice, or turn the PIN off.");
      const pinTyped = primaryPin;
      setPrimaryPin("");
      const { profile: created, warning } = await createProfileWithOptions(name, avatar, {
        copyAddons, copyConnections, primaryPin: pinTyped, pin: usePin ? newPin : null,
      });
      onDone(created, warning);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const canSave = !busy && profileNameOk(name) && !linkBlocks && (!!profile || ((!usePin || !!newPin) && (!needPrimaryPin || pinOk(primaryPin))));

  const remove = async () => {
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      if (hasPin) {
        const v = await verifyPin(profile.id, deletePin);
        setDeletePin("");
        if (v !== "ok") throw new Error(pinMessage(profile.id, v));
      }
      await deleteProfile(profile.id);
      onDone();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  return (
    <form className="profile-editor" onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); }}>
      <h1>{profile ? "Edit profile" : first ? "Create your profile" : "Add a profile"}</h1>
      {first && <p className="auth-p">Each profile has its own library, watchlist, progress, addons and Trakt/TMDB connections. Settings are shared by the whole account.</p>}
      <div className="profile-editor-row">
        {isAvatarUrl(avatar) ? (
          <span className="avatar avatar-art avatar-preview" style={{ width: 120, height: 120 }} aria-label="Image preview">
            {linkState === "error" ? (
              <span className="avatar-preview-error"><ImageIcon size={30} /><span>Couldn't load</span></span>
            ) : (
              <img key={avatar} src={avatar} alt="" referrerPolicy="no-referrer" decoding="async" draggable={false} onLoad={() => setLinkState("ok")} onError={() => setLinkState("error")} />
            )}
          </span>
        ) : (
          <Avatar avatar={avatar} size={120} />
        )}
        <label className="auth-field" style={{ flex: 1 }}>
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value.slice(0, 32))} maxLength={32} autoFocus placeholder="Name" />
        </label>
      </div>
      <div className="avatar-tabs" role="tablist" aria-label="Avatar groups">
        {AVATAR_CATEGORIES.map((c) => (
          <button
            type="button" key={c.id} role="tab" aria-selected={cat === c.id} className={`avatar-tab ${cat === c.id ? "on" : ""} ${currentCat === c.id ? "has-current" : ""}`}
            onClick={() => setCat(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="avatar-picker" role="radiogroup" aria-label={`${AVATAR_CATEGORIES.find((c) => c.id === cat)?.label ?? ""} avatars`}>
        {AVATAR_ART.filter((a) => avatarCategory(a) === cat).map((a) => {
          const on = !isAvatarUrl(avatar) && avatarArt(avatar).key === a.key;
          return (
            <button type="button" key={a.key} role="radio" aria-checked={on} aria-label={a.label} title={a.label} className={on ? "on" : ""} onClick={() => pickBuiltIn(a.key)}>
              <Avatar avatar={a.key} size={52} />
            </button>
          );
        })}
      </div>
      {linkMode ? (
        <div className="avatar-link">
          <label className="auth-field">
            <span>Image link</span>
            <input
              className="input" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://example.com/me.png"
              value={link} maxLength={AVATAR_URL_MAX + 1} onChange={(e) => onLink(e.target.value)} aria-invalid={linkState === "invalid" || linkState === "error"}
            />
          </label>
          <div className={`avatar-link-hint ${linkState === "invalid" || linkState === "error" ? "bad" : ""}`} role="status">
            {linkState === "invalid"
              ? `Use a public https link that ends in .jpg, .jpeg, .png, .webp or .gif (up to ${AVATAR_URL_MAX} characters).`
              : linkState === "error"
                ? "That image couldn't be loaded. Check that the link is public."
                : linkState === "loading"
                  ? "Loading preview…"
                  : linkState === "ok"
                    ? "Looks good. Everyone on this account sees this picture, and it syncs to your other devices."
                    : "Paste a public https link to a .jpg, .jpeg, .png, .webp or .gif image."}
          </div>
          <button type="button" className="auth-link inline" onClick={() => { setLinkMode(false); if (isAvatarUrl(avatar)) setAvatar(profile && !isAvatarUrl(profile.avatar) ? profile.avatar : DEFAULT_AVATAR); }}>
            Use a built-in avatar instead
          </button>
        </div>
      ) : (
        <button type="button" className="btn ghost avatar-link-open" onClick={() => setLinkMode(true)}><Link2 size={16} /> Use an image link</button>
      )}
      {!profile && primary && (
        <fieldset className="profile-options">
          <legend>Start from {primary.name}</legend>
          <label className="profile-option">
            <input type="checkbox" checked={copyAddons} onChange={(e) => setCopyAddons(e.target.checked)} />
            <span>
              Copy addons from {primary.name}
              <small>{copyAddons ? `Starts with ${primary.name}'s installed addons.` : "Starts with the default addons (Cinemeta and OpenSubtitles)."}</small>
            </span>
          </label>
          <label className="profile-option">
            <input type="checkbox" checked={copyConnections} onChange={(e) => setCopyConnections(e.target.checked)} />
            <span>
              Copy Trakt and TMDB connections from {primary.name}
              <small>Copies {primary.name}'s Trakt sign-in and TMDB key on this computer only. Both profiles then use the same Trakt account.</small>
            </span>
          </label>
          {needPrimaryPin && (
            <label className="auth-field">
              <span><LockBadge size={12} /> {primary.name}'s PIN (needed to copy from a locked profile)</span>
              <input className="input pin-input" type="password" inputMode="numeric" autoComplete="off" value={primaryPin} maxLength={PIN_MAX} onChange={(e) => setPrimaryPin(pinInput(e.target.value))} />
            </label>
          )}
        </fieldset>
      )}
      {!profile && (
        <fieldset className="profile-options">
          <label className="profile-option">
            <input type="checkbox" checked={usePin} onChange={(e) => setUsePin(e.target.checked)} />
            <span>
              Lock this profile with a PIN
              <small>{HOUSEHOLD_NOTE}</small>
            </span>
          </label>
          {usePin && <NewPinFields onChange={onNewPin} />}
        </fieldset>
      )}
      {profile && <PinSettings profile={profile} hasPin={hasPin} />}
      {profile && confirmDelete && hasPin && (
        <label className="auth-field profile-delete-pin">
          <span>Enter {profile.name}'s PIN to delete it</span>
          <input className="input pin-input" type="password" inputMode="numeric" autoComplete="off" value={deletePin} maxLength={PIN_MAX} autoFocus
            onChange={(e) => setDeletePin(pinInput(e.target.value))}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault(); // Enter here deletes, it doesn't save the form
              if (!busy && pinOk(deletePin)) void remove();
            }}
          />
        </label>
      )}
      {error && <div className="auth-msg error">{error}</div>}
      <div className="profiles-actions">
        <button className="btn primary large" disabled={!canSave}>
          {busy ? <Loader2 size={18} className="acct-spin" /> : <Check size={18} />} Save
        </button>
        {!first && <button type="button" className="btn glass large" onClick={() => onDone()} disabled={busy}>Cancel</button>}
        {profile && (
          confirmDelete ? (
            <button type="button" className="btn danger-solid large" onClick={() => void remove()} disabled={busy || (hasPin && !pinOk(deletePin))}>
              <Trash2 size={18} /> Delete profile and its library
            </button>
          ) : (
            <button type="button" className="btn ghost large danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
              <Trash2 size={18} /> Delete
            </button>
          )
        )}
      </div>
    </form>
  );
}

/**
 * Top-bar profile button. Guests get a "Sign in" button; signed-in users get their avatar with a
 * menu to switch profile, manage profiles, open account settings, or sign out.
 */
export function ProfileSwitcher() {
  const account = useAccount();
  const sync = useSync();
  const { navigate } = useApp();
  const [open, setOpen] = useState(false);
  const [pinFor, setPinFor] = useState<Profile | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!switchError) return;
    const t = window.setTimeout(() => setSwitchError(null), 5000);
    return () => window.clearTimeout(t);
  }, [switchError]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (account.status !== "signedIn") {
    return (
      <button className="icon-btn" onClick={() => showAuthScreen(true)} title="Sign in" aria-label="Sign in">
        <UserRound size={19} />
      </button>
    );
  }

  const active = sync.active;
  const others = sync.profiles.filter((p) => p.id !== active?.id);
  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="profile-switcher" ref={ref}>
      <button className="profile-switcher-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={active ? `${active.name} — switch profile` : "Profiles"}>
        {active ? <Avatar avatar={active.avatar} size={32} /> : <UserRound size={19} />}
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          {active && (
            <div className="profile-menu-head">
              <Avatar avatar={active.avatar} size={36} />
              <div>
                <div className="profile-menu-name">{active.name}</div>
                {account.email && <div className="profile-menu-sub">{account.email}</div>}
              </div>
            </div>
          )}
          {others.map((p) => (
            <button key={p.id} role="menuitem" onClick={act(() => (sync.pins[p.id] ? setPinFor(p) : void selectProfile(p).catch((e) => setSwitchError(msg(e)))))}>
              <Avatar avatar={p.avatar} size={26} /> <span className="profile-menu-label">{p.name}</span>
              {sync.pins[p.id] && <LockBadge size={12} />}
            </button>
          ))}
          <div className="profile-menu-sep" />
          <button role="menuitem" onClick={act(() => showProfilePicker("manage"))}><Users size={17} /> Manage profiles</button>
          <button role="menuitem" onClick={act(() => navigate({ name: "settings", section: "account" }))}><SettingsIcon size={17} /> Account settings</button>
          <button role="menuitem" onClick={act(() => void syncAndSignOut())}><LogOut size={17} /> Sign out</button>
        </div>
      )}
      {pinFor && (
        <PinPad
          key={pinFor.id}
          profile={pinFor}
          onCancel={() => setPinFor(null)}
          onOk={async () => {
            const p = pinFor;
            setPinFor(null);
            await selectProfile(p, { pinVerified: true }).catch((e) => setSwitchError(msg(e)));
          }}
        />
      )}
      {switchError && (
        <div className="toasts" style={{ bottom: 90 }}>
          <div className="toast error" role="alert" onClick={() => setSwitchError(null)}>{switchError}</div>
        </div>
      )}
    </div>
  );
}
