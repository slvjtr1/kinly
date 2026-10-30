// Profile PIN UI: the PIN pad shown before a locked profile opens, the PIN fields used when
// creating a profile, and the PIN section of "Edit profile". A PIN is a household lock (it keeps
// others on the same account from opening the profile in Kinly), not account security.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Delete, KeyRound, Loader2, Lock, X } from "lucide-react";
import { reauthenticate } from "../lib/account";
import { PIN_MAX, PIN_MIN, pinInput, pinMessage, pinOk, setPin, verifyPin } from "../lib/pins";
import { notePinChanged, type Profile } from "../lib/sync";
import { Avatar } from "./Profiles";
import "../styles/profiles.css";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

export const HOUSEHOLD_NOTE = "A PIN is a household lock: it stops others on this account from opening the profile in Kinly. It doesn't protect your account or its data.";

/** Small lock badge for profiles with a PIN. */
export function LockBadge({ size = 14 }: { size?: number }) {
  return (
    <span className="profile-lock" title="Locked with a PIN" aria-label="Locked with a PIN">
      <Lock size={size} strokeWidth={2.5} />
    </span>
  );
}

/**
 * Asks for a profile's PIN and checks it with the server. `onOk` runs only after "ok". Wrong
 * guesses and the server's lock-out are shown; the PIN itself is cleared after every try.
 * "Forgot PIN?" asks for the account password, then sets a new PIN (or removes it) and opens.
 * Rendered into <body> so no transformed or filtered ancestor (the top bar) can clip it.
 */
export function PinPad({ profile, onOk, onCancel, purpose }: { profile: Profile; onOk: () => void | Promise<void>; onCancel: () => void; purpose?: string }) {
  const [pin, setPinValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [forgot, setForgot] = useState<null | "password" | "new">(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!forgot) input.current?.focus();
  }, [forgot]);

  const submit = async (value = pin) => {
    if (busy || !pinOk(value)) return;
    setBusy(true);
    setError(null);
    try {
      const v = await verifyPin(profile.id, value);
      setPinValue("");
      if (v === "ok") {
        await onOk();
        return;
      }
      setError(pinMessage(profile.id, v));
      setShake((n) => n + 1);
    } catch (e) {
      setPinValue("");
      setError(msg(e));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  const press = (d: string) => {
    if (busy) return;
    setError(null);
    setPinValue((p) => pinInput(p + d));
    input.current?.focus();
  };

  const back = () => {
    setForgot(null);
    setError(null);
  };

  return createPortal(
    <div
      className="pin-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Enter the PIN for ${profile.name}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (forgot) back();
          else onCancel();
        }
      }}
    >
      {forgot ? (
        <ForgotPin profile={profile} step={forgot} onStep={setForgot} onBack={back} onDone={onOk} />
      ) : (
        <form className="pin-card" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <button type="button" className="icon-btn pin-close" onClick={onCancel} aria-label="Cancel"><X size={18} /></button>
          <span className="pin-face">
            <Avatar avatar={profile.avatar} size={84} />
            <LockBadge size={15} />
          </span>
          <h2 className="pin-title">{profile.name}</h2>
          <p className="pin-sub">{purpose ?? "Enter the profile PIN to open it."}</p>
          <label className="pin-entry">
            <span className="sr-only">PIN</span>
            <input
              ref={input}
              className="pin-hidden-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              maxLength={PIN_MAX}
              onChange={(e) => {
                setError(null);
                setPinValue(pinInput(e.target.value));
              }}
              aria-invalid={!!error}
            />
            <span key={shake} className={`pin-dots ${shake ? "shake" : ""}`} aria-hidden="true">
              {Array.from({ length: Math.max(PIN_MIN, pin.length) }, (_, i) => (
                <i key={i} className={i < pin.length ? "on" : ""} />
              ))}
            </span>
          </label>
          <div className="pin-keys">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button type="button" key={d} className="pin-key" onClick={() => press(d)} disabled={busy}>{d}</button>
            ))}
            <button type="button" className="pin-key ghost" onClick={() => setPinValue((p) => p.slice(0, -1))} disabled={busy || !pin} aria-label="Delete digit"><Delete size={20} /></button>
            <button type="button" className="pin-key" onClick={() => press("0")} disabled={busy}>0</button>
            <button className="pin-key ok" disabled={busy || !pinOk(pin)} aria-label="Open profile">
              {busy ? <Loader2 size={20} className="acct-spin" /> : <Check size={22} />}
            </button>
          </div>
          <div className={`auth-msg error pin-msg ${error ? "" : "hidden"}`} role="alert">{error ?? " "}</div>
          <button type="button" className="auth-link inline pin-forgot" onClick={() => { setPinValue(""); setError(null); setForgot("password"); }} disabled={busy}>
            Forgot PIN?
          </button>
        </form>
      )}
    </div>,
    document.body,
  );
}

/** "Forgot PIN?" inside the pad: account password, then a new PIN (or none), then the profile opens. */
function ForgotPin({ profile, step, onStep, onBack, onDone }: {
  profile: Profile; step: "password" | "new"; onStep: (s: "password" | "new") => void; onBack: () => void; onDone: () => void | Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = () =>
    run(async () => {
      await reauthenticate(password);
      setPassword("");
      onStep("new");
    });

  const save = (pin: string | null) =>
    run(async () => {
      const v = await setPin(profile.id, pin, null);
      if (v === "ok") {
        notePinChanged(profile.id, pin !== null);
        await onDone();
        return;
      }
      if (v === "wrong") {
        // The password sign-in is older than 5 minutes.
        onStep("password");
        setError("That took more than 5 minutes. Enter the account password again.");
        return;
      }
      setError(pinMessage(profile.id, v));
    });

  return (
    <form
      className="pin-card pin-forgot-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        if (step === "password" && password) void confirm();
        else if (step === "new" && next) void save(next);
      }}
    >
      <button type="button" className="icon-btn pin-close" onClick={onBack} aria-label="Back to the PIN pad"><X size={18} /></button>
      <span className="pin-face">
        <Avatar avatar={profile.avatar} size={64} />
        <LockBadge size={13} />
      </span>
      <h2 className="pin-title">Forgot {profile.name}'s PIN?</h2>
      {step === "password" ? (
        <>
          <p className="pin-sub">Enter the Kinly account password to set a new PIN or remove it.</p>
          <label className="auth-field">
            <span>Account password</span>
            <input className="input" type="password" autoComplete="current-password" value={password} maxLength={128} autoFocus onChange={(e) => setPassword(e.target.value)} />
          </label>
        </>
      ) : (
        <>
          <p className="pin-sub">Choose a new PIN for {profile.name}, or remove it.</p>
          <NewPinFields label="New PIN" onChange={setNext} autoFocus />
        </>
      )}
      {error && <div className="auth-msg error pin-msg" role="alert">{error}</div>}
      <div className="acct-actions pin-forgot-actions">
        <button type="button" className="btn" onClick={onBack} disabled={busy}>Back</button>
        {step === "password" ? (
          <button className="btn primary" disabled={busy || !password}>{busy ? <Loader2 size={16} className="acct-spin" /> : null} Continue</button>
        ) : (
          <>
            <button type="button" className="btn ghost danger" disabled={busy} onClick={() => void save(null)}>Remove PIN</button>
            <button className="btn primary" disabled={busy || !next}>{busy ? <Loader2 size={16} className="acct-spin" /> : <Check size={16} />} Save and open</button>
          </>
        )}
      </div>
    </form>
  );
}

/** Two PIN fields (new + repeat). Reports the PIN when both match and it is valid, else null. */
export function NewPinFields({ onChange, label = "PIN", autoFocus }: { onChange: (pin: string | null) => void; label?: string; autoFocus?: boolean }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  useEffect(() => {
    onChange(pinOk(a) && a === b ? a : null);
  }, [a, b, onChange]);
  const hint = !a ? `${PIN_MIN} to ${PIN_MAX} digits.` : !pinOk(a) ? `Use ${PIN_MIN} to ${PIN_MAX} digits.` : b && a !== b ? "The PINs don't match." : !b ? "Enter it again to confirm." : "PINs match.";
  return (
    <div className="pin-fields">
      <label className="auth-field">
        <span>{label}</span>
        <input className="input pin-input" type="password" inputMode="numeric" autoComplete="off" value={a} maxLength={PIN_MAX} onChange={(e) => setA(pinInput(e.target.value))} autoFocus={autoFocus} />
      </label>
      <label className="auth-field">
        <span>Repeat {label.replace(/^New /, "new ")}</span>
        <input className="input pin-input" type="password" inputMode="numeric" autoComplete="off" value={b} maxLength={PIN_MAX} onChange={(e) => setB(pinInput(e.target.value))} />
      </label>
      <div className={`pin-hint ${a && (!pinOk(a) || (b && a !== b)) ? "bad" : ""}`} role="status">{hint}</div>
    </div>
  );
}

type Mode = "idle" | "set" | "change" | "remove" | "forgot" | "forgot-new";

/** The PIN section of "Edit profile": set, change, remove, or reset with the account password. */
export function PinSettings({ profile, hasPin }: { profile: Profile; hasPin: boolean }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reset = (m: Mode = "idle") => {
    setMode(m);
    setCurrent("");
    setNext(null);
    setPassword("");
    setError(null);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = (pin: string | null, cur: string | null, fresh = false) =>
    run(async () => {
      const v = await setPin(profile.id, pin, cur);
      if (v === "ok") {
        notePinChanged(profile.id, pin !== null);
        reset();
        setDone(pin === null ? "PIN removed." : "PIN saved.");
        return;
      }
      setCurrent("");
      if (fresh && v === "wrong") {
        // The password sign-in is older than 5 minutes: ask for the password again.
        reset("forgot");
        setError("That took more than 5 minutes. Enter the account password again.");
        return;
      }
      setError(pinMessage(profile.id, v));
    });

  const confirmPassword = () =>
    run(async () => {
      await reauthenticate(password);
      setPassword("");
      setMode("forgot-new");
    });

  // The primary action of the current step, also run by Enter in any of its fields.
  const primary: (() => void) | null =
    busy ? null
    : mode === "set" ? (next ? () => void apply(next, null) : null)
    : mode === "change" ? (next && pinOk(current) ? () => void apply(next, current) : null)
    : mode === "remove" ? (pinOk(current) ? () => void apply(null, current) : null)
    : mode === "forgot" ? (password ? () => void confirmPassword() : null)
    : mode === "forgot-new" ? (next ? () => void apply(next, null, true) : null)
    : null;

  return (
    <div
      className="pin-section"
      onKeyDown={(e) => {
        // This section sits inside the "Edit profile" form: Enter must not save the whole form.
        if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement)) return;
        e.preventDefault();
        primary?.();
      }}
    >
      <div className="pin-section-head">
        <KeyRound size={17} />
        <div>
          <div className="pin-section-title">Profile PIN {hasPin ? <span className="pin-on">On</span> : <span className="pin-off">Off</span>}</div>
          <div className="pin-section-help">{HOUSEHOLD_NOTE}</div>
        </div>
      </div>

      {mode === "idle" && (
        <div className="acct-actions start">
          {hasPin ? (
            <>
              <button type="button" className="btn" onClick={() => reset("change")}>Change PIN</button>
              <button type="button" className="btn ghost danger" onClick={() => reset("remove")}>Remove PIN</button>
              <button type="button" className="auth-link inline" onClick={() => reset("forgot")}>Forgot PIN?</button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => reset("set")}><Lock size={15} /> Set a PIN</button>
          )}
        </div>
      )}

      {(mode === "change" || mode === "remove") && (
        <label className="auth-field">
          <span>Current PIN</span>
          <input
            className="input pin-input" type="password" inputMode="numeric" autoComplete="off" value={current} maxLength={PIN_MAX} autoFocus
            onChange={(e) => setCurrent(pinInput(e.target.value))}
          />
        </label>
      )}
      {(mode === "set" || mode === "change" || mode === "forgot-new") && <NewPinFields label={mode === "set" ? "PIN" : "New PIN"} onChange={setNext} autoFocus={mode !== "change"} />}
      {mode === "forgot" && (
        <>
          <p className="pin-section-help">Enter the account password to set a new PIN or remove it without the current one.</p>
          <label className="auth-field">
            <span>Account password</span>
            <input
              className="input" type="password" autoComplete="current-password" value={password} maxLength={128} autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </>
      )}

      {error && <div className="auth-msg error" role="alert">{error}</div>}
      {done && mode === "idle" && <div className="auth-msg"><Check size={14} /> {done}</div>}

      {mode !== "idle" && (
        <div className="acct-actions start">
          <button type="button" className="btn" onClick={() => reset()} disabled={busy}>Cancel</button>
          {mode === "set" && (
            <button type="button" className="btn primary" disabled={!primary} onClick={() => primary?.()}>
              {busy ? <Loader2 size={16} className="acct-spin" /> : <Check size={16} />} Save PIN
            </button>
          )}
          {mode === "change" && (
            <button type="button" className="btn primary" disabled={!primary} onClick={() => primary?.()}>
              {busy ? <Loader2 size={16} className="acct-spin" /> : <Check size={16} />} Change PIN
            </button>
          )}
          {mode === "remove" && (
            <button type="button" className="btn danger-solid" disabled={!primary} onClick={() => primary?.()}>
              {busy ? <Loader2 size={16} className="acct-spin" /> : null} Remove PIN
            </button>
          )}
          {mode === "forgot" && (
            <button type="button" className="btn primary" disabled={!primary} onClick={() => primary?.()}>
              {busy ? <Loader2 size={16} className="acct-spin" /> : null} Continue
            </button>
          )}
          {mode === "forgot-new" && (
            <>
              <button type="button" className="btn ghost danger" disabled={busy} onClick={() => void apply(null, null, true)}>Remove PIN</button>
              <button type="button" className="btn primary" disabled={!primary} onClick={() => primary?.()}>
                {busy ? <Loader2 size={16} className="acct-spin" /> : <Check size={16} />} Save new PIN
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
