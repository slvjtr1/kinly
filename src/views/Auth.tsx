import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, Eye, EyeOff, Loader2, MailCheck, X } from "lucide-react";
import {
  checkPassword, continueAsGuest, normalizeEmail, requestRecovery, resetPassword, showAuthScreen, signIn, signInWaitMs, signUp,
  trySignInAfterConfirm, verifySignupCode,
} from "../lib/account";
import { authCallbackListen, onAuthCallback } from "../lib/tauri";

type Mode = "signin" | "signup" | "confirm" | "forgot" | "reset";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");

/** Full-screen sign in / sign up / password reset. `onClose` is set when opened from the app (not first run). */
export default function Auth({ onClose }: { onClose?: () => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  // The new account's password, kept in memory only while waiting for the email confirmation so
  // Kinly can sign in by itself once the link is clicked. Cleared when leaving that screen.
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (mode !== "confirm" || !pending.current) return;
    let live = true;
    let trying = false;
    const attempt = async () => {
      if (!live || trying || !pending.current) return;
      trying = true;
      try {
        if (await trySignInAfterConfirm(email, pending.current)) {
          pending.current = null;
          if (live) showAuthScreen(false);
        }
      } catch {
        // Offline or rate limited: the next tick tries again.
      } finally {
        trying = false;
      }
    };
    void authCallbackListen();
    const un = onAuthCallback(() => void attempt());
    const timer = window.setInterval(() => void attempt(), 15000);
    return () => {
      live = false;
      window.clearInterval(timer);
      void un.then((u) => u());
    };
  }, [mode, email]);
  useEffect(() => {
    if (mode !== "confirm") pending.current = null;
  }, [mode]);

  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setInterval(() => setWait(signInWaitMs()), 500);
    return () => window.clearInterval(t);
  }, [wait]);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = (m: Mode) => {
    setMode(m);
    setError(null);
    setNotice(null);
    setPassword("");
    setConfirm("");
    setCode("");
  };

  const emailOk = normalizeEmail(email) !== null;
  const pw = useMemo(() => checkPassword(password, email), [password, email]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
      setWait(signInWaitMs());
    } finally {
      setBusy(false);
    }
  };

  const done = () => showAuthScreen(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (mode === "signin") void run(async () => {
      await signIn(email, password);
      setPassword("");
      done();
    });
    if (mode === "signup") {
      if (password !== confirm) return setError("The passwords don't match.");
      void run(async () => {
        const r = await signUp(email, password);
        const pw = password;
        setPassword("");
        setConfirm("");
        if (r === "signedIn") done();
        else {
          pending.current = pw;
          go("confirm");
        }
      });
    }
    if (mode === "confirm") void run(async () => {
      await verifySignupCode(email, code);
      done();
    });
    if (mode === "forgot") void run(async () => {
      await requestRecovery(email);
      go("reset");
      setNotice("If an account exists for this address, we've emailed a code to it.");
    });
    if (mode === "reset") {
      if (password !== confirm) return setError("The passwords don't match.");
      void run(async () => {
        await resetPassword(email, code, password);
        setPassword("");
        setConfirm("");
        done();
      });
    }
  };

  const pwField = (label: string, value: string, set: (v: string) => void, auto: string) => (
    <label className="auth-field">
      <span>{label}</span>
      <div className="auth-pw">
        <input className="input" type={show ? "text" : "password"} value={value} onChange={(e) => set(e.target.value)} autoComplete={auto} maxLength={128} required />
        <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}>
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </label>
  );

  const emailField = (
    <label className="auth-field">
      <span>Email</span>
      <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required autoFocus />
    </label>
  );

  const codeField = (
    <label className="auth-field">
      <span>Code from the email</span>
      <input
        className="input auth-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, "").slice(0, 10))}
        placeholder="123456"
        autoFocus
      />
    </label>
  );

  let body: ReactNode;
  if (mode === "signin" || mode === "signup") {
    const isUp = mode === "signup";
    body = (
      <>
        <div className="auth-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!isUp} className={!isUp ? "active" : ""} onClick={() => go("signin")}>Sign in</button>
          <button type="button" role="tab" aria-selected={isUp} className={isUp ? "active" : ""} onClick={() => go("signup")}>Create account</button>
        </div>
        {emailField}
        {pwField("Password", password, setPassword, isUp ? "new-password" : "current-password")}
        {isUp && (
          <>
            <StrengthMeter score={pw.score} problems={password ? pw.problems : []} />
            {pwField("Confirm password", confirm, setConfirm, "new-password")}
          </>
        )}
        <Feedback error={error} notice={notice} />
        <button className="btn primary large auth-submit" disabled={busy || !emailOk || (isUp ? !pw.ok || !confirm : !password || wait > 0)}>
          {busy ? <Loader2 size={18} className="acct-spin" /> : null}
          {isUp ? "Create account" : wait > 0 ? `Try again in ${Math.ceil(wait / 1000)} s` : "Sign in"}
        </button>
        {!isUp && (
          <button type="button" className="auth-link" onClick={() => go("forgot")}>Forgot password?</button>
        )}
      </>
    );
  } else if (mode === "confirm") {
    body = (
      <>
        <Back onClick={() => go("signup")} />
        <div className="auth-check">
          <MailCheck size={40} />
          <h2>Check your email</h2>
          <p>We sent a confirmation to <b>{normalizeEmail(email) ?? email}</b>. Click the link in it once and Kinly signs you in automatically. If the email shows a code, you can enter it instead.</p>
          {pending.current && <p className="auth-wait"><Loader2 size={14} className="acct-spin" /> Waiting for confirmation…</p>}
        </div>
        {codeField}
        <Feedback error={error} notice={notice} />
        <button className="btn primary large auth-submit" disabled={busy || code.length < 6}>
          {busy ? <Loader2 size={18} className="acct-spin" /> : null} Confirm with code
        </button>
        <button type="button" className="btn glass large auth-submit" onClick={() => go("signin")}>I clicked the link — sign in</button>
      </>
    );
  } else if (mode === "forgot") {
    body = (
      <>
        <Back onClick={() => go("signin")} />
        <h2 className="auth-h">Reset your password</h2>
        <p className="auth-p">Enter your account email. We'll send a code you can use to choose a new password.</p>
        {emailField}
        <Feedback error={error} notice={notice} />
        <button className="btn primary large auth-submit" disabled={busy || !emailOk}>
          {busy ? <Loader2 size={18} className="acct-spin" /> : null} Send code
        </button>
        <button type="button" className="auth-link" onClick={() => go("reset")}>I already have a code</button>
      </>
    );
  } else {
    body = (
      <>
        <Back onClick={() => go("forgot")} />
        <h2 className="auth-h">Choose a new password</h2>
        {emailField}
        {codeField}
        {pwField("New password", password, setPassword, "new-password")}
        <StrengthMeter score={pw.score} problems={password ? pw.problems : []} />
        {pwField("Confirm new password", confirm, setConfirm, "new-password")}
        <Feedback error={error} notice={notice} />
        <button className="btn primary large auth-submit" disabled={busy || !emailOk || code.length < 6 || !pw.ok || !confirm}>
          {busy ? <Loader2 size={18} className="acct-spin" /> : null} Set password and sign in
        </button>
      </>
    );
  }

  return (
    <div className="auth" role="dialog" aria-modal="true" aria-label="Sign in to Kinly">
      <div className="auth-bg" aria-hidden="true">
        <div className="auth-orb a" />
        <div className="auth-orb b" />
        <div className="auth-swell" />
      </div>
      {onClose && (
        <button className="icon-btn auth-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
      )}
      <div className="auth-inner">
        <div className="auth-brand">
          <div className="wordmark"><span className="kin">Kin</span><span className="ly">ly</span></div>
          <p>Your movies, series and progress — on every screen, for everyone at home.</p>
        </div>
        <form className="auth-card" onSubmit={submit} noValidate>
          {body}
        </form>
        {!onClose && (
          <button className="auth-guest" onClick={() => void continueAsGuest()}>
            Continue as guest
            <small>Everything stays on this computer. You can sign in later in Settings.</small>
          </button>
        )}
      </div>
    </div>
  );
}

function Back({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="auth-back" onClick={onClick}><ArrowLeft size={16} /> Back</button>
  );
}

function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
  if (error) return <div className="auth-msg error" role="alert">{error}</div>;
  if (notice) return <div className="auth-msg" role="status">{notice}</div>;
  return null;
}

const LABELS = ["Too weak", "Weak", "Fair", "Good", "Strong"];

export function StrengthMeter({ score, problems }: { score: number; problems: string[] }) {
  return (
    <div className="strength" aria-live="polite">
      <div className={`strength-bars s${score}`}>
        {[0, 1, 2, 3].map((i) => <i key={i} className={i < score ? "on" : ""} />)}
      </div>
      <div className="strength-label">
        {problems.length ? problems[0] : LABELS[score]}
      </div>
    </div>
  );
}
