// Kinly accounts: Supabase Auth over its REST API, through the Rust HTTP client.
//
// Security rules followed here (see ACCOUNTS.md):
// - Tokens, passwords and emails are never logged or put in error messages.
// - The "account" store (written 0600 by Rust) holds only the access token, refresh token and
//   expiry, or `guest: true`. The password is never stored; the email is kept in memory only.
// - Every server response is validated before use. Error messages are generic and never reveal
//   whether an email address has an account.

import { useSyncExternalStore } from "react";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./supabaseConfig";
import { http, storeLoad, storeSave, uiLog, type HttpResponse } from "./tauri";

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested)

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd", "p@ssw0rd", "p@ssword",
  "123456789", "1234567890", "12345678910", "0123456789", "987654321", "9876543210", "1q2w3e4r5t", "1qaz2wsx3edc",
  "qwerty", "qwerty123", "qwerty1234", "qwertyuiop", "qwertyuiop1", "asdfghjkl", "asdfghjkl1", "zxcvbnm123",
  "iloveyou", "iloveyou1", "iloveyou12", "letmein", "letmein123", "welcome", "welcome1", "welcome123", "welcome2024",
  "admin", "admin123", "admin12345", "administrator", "changeme", "changeme1", "changeme123", "trustno1",
  "football", "football1", "baseball", "baseball1", "basketball", "superman", "superman1", "batman123",
  "princess", "princess1", "sunshine", "sunshine1", "starwars", "starwars1", "dragon123", "monkey123",
  "master123", "shadow123", "michael123", "jennifer1", "computer", "computer1", "internet", "whatever1",
  "abcdefghij", "abcd123456", "abc1234567", "a123456789", "aa12345678", "1234qwer", "qwer1234",
  "kinly", "kinly123", "kinly12345", "stremio123", "netflix123", "password!", "password1!", "qwerty123!",
  "summer2024", "winter2024", "spring2024", "autumn2024", "summer2025", "winter2025", "summer2026", "winter2026",
]);

// Profile avatars: a built-in avatar key, or a public https image link. Mirrors the
// profiles_avatar_check constraint (supabase/migrations/20261028190000_profile_avatar_urls.sql).
export const AVATAR_KEY = /^[a-z0-9-]{1,24}$/;
export const AVATAR_URL = /^https:\/\/[a-z0-9.-]+(:[0-9]{2,5})?\/[^\s"'<>\\]*\.(jpe?g|png|webp|gif)(\?[^\s"'<>\\]*)?$/i;
export const AVATAR_URL_MAX = 512;

/** True for an avatar value the server accepts. */
export const avatarOk = (v: string): boolean => AVATAR_KEY.test(v) || isAvatarUrl(v);
/** True for an image-link avatar the server accepts. */
export const isAvatarUrl = (v: string): boolean => v.length <= AVATAR_URL_MAX && AVATAR_URL.test(v);

export type PasswordCheck = { ok: boolean; problems: string[]; score: 0 | 1 | 2 | 3 | 4 };

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 72; // bcrypt limit used by Supabase Auth

function charClasses(pw: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
}

/** Kinly password policy: at least 10 characters, more than one character class, not a common password. */
export function checkPassword(pw: string, email = ""): PasswordCheck {
  const problems: string[] = [];
  if (pw.length < PASSWORD_MIN) problems.push(`Use at least ${PASSWORD_MIN} characters`);
  if (pw.length > PASSWORD_MAX) problems.push(`Use at most ${PASSWORD_MAX} characters`);
  const classes = charClasses(pw);
  if (pw.length > 0 && classes < 2) problems.push("Mix letters with numbers, capitals or symbols");
  const lower = pw.toLowerCase();
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(lower.replace(/[^a-z0-9]+$/, ""))) problems.push("This password is too common");
  else if (/^(.)\1+$/.test(pw)) problems.push("Don't repeat a single character");
  else if (local.length >= 4 && lower.includes(local)) problems.push("Don't use your email address in the password");

  let score = 0;
  if (pw.length >= PASSWORD_MIN) score++;
  if (pw.length >= 14) score++;
  if (classes >= 3) score++;
  if (pw.length >= 18 || (classes === 4 && pw.length >= 12)) score++;
  if (problems.length) score = Math.min(score, 1);
  return { ok: problems.length === 0, problems, score: score as PasswordCheck["score"] };
}

/** Trim and validate an email address; returns the normalised address or null. */
export function normalizeEmail(input: string): string | null {
  const e = input.trim();
  if (e.length < 3 || e.length > 254) return null;
  if (!/^[^\s@"<>()[\]\\,;:]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(e)) return null;
  const [local, domain] = e.split("@");
  if (local.length > 64) return null;
  return `${local}@${domain.toLowerCase()}`;
}

function b64urlDecode(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export type JwtClaims = { sub: string; exp: number; iss?: string; aud?: string | string[]; email?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decodes (does not verify) a JWT and checks the claims Kinly relies on. */
export function decodeJwt(token: string, expectedIssuer = `${SUPABASE_URL}/auth/v1`): JwtClaims | null {
  if (typeof token !== "string" || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  const json = b64urlDecode(parts[1]);
  if (!json) return null;
  let c: unknown;
  try {
    c = JSON.parse(json);
  } catch {
    return null;
  }
  if (!c || typeof c !== "object") return null;
  const claims = c as Record<string, unknown>;
  if (typeof claims.sub !== "string" || !UUID.test(claims.sub)) return null;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
  if (expectedIssuer && claims.iss !== undefined && claims.iss !== expectedIssuer) return null;
  return claims as unknown as JwtClaims;
}

/** True when the token is malformed or expires within `skewSec` seconds. */
export function isJwtExpired(token: string, nowMs = Date.now(), skewSec = 30): boolean {
  const c = decodeJwt(token);
  return !c || c.exp * 1000 <= nowMs + skewSec * 1000;
}

/** Client-side delay after `failures` consecutive failed sign-ins: none for the first, then 2 s, 4 s, ... up to 5 min. */
export function backoffDelayMs(failures: number): number {
  if (failures <= 1) return 0;
  return Math.min(2 ** (failures - 1) * 1000, 5 * 60_000);
}

export type StoredSession = { access_token: string; refresh_token: string; expires_at: number };
export type AccountDoc = { v: 1; guest?: boolean; session?: StoredSession };

/** Validates a Supabase token response (or a stored session); returns what Kinly stores, or null. */
export function parseSession(x: unknown, nowMs = Date.now()): StoredSession | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.access_token !== "string" || typeof r.refresh_token !== "string") return null;
  if (r.refresh_token.length < 1 || r.refresh_token.length > 1024 || /\s/.test(r.refresh_token)) return null;
  const claims = decodeJwt(r.access_token);
  if (!claims) return null;
  let exp = claims.exp;
  if (typeof r.expires_at === "number" && Number.isFinite(r.expires_at)) exp = Math.min(exp, r.expires_at);
  else if (typeof r.expires_in === "number" && Number.isFinite(r.expires_in)) exp = Math.min(exp, Math.floor(nowMs / 1000) + r.expires_in);
  return { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: exp };
}

export function parseAccountDoc(x: unknown): AccountDoc | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const session = r.session ? parseSession(r.session) : null;
  return { v: 1, ...(r.guest === true ? { guest: true } : {}), ...(session ? { session } : {}) };
}

export class AuthError extends Error {
  constructor(message: string, readonly code: "invalid" | "rate" | "network" | "weak" | "server" | "expired" = "server") {
    super(message);
  }
}

function errorCode(r: HttpResponse): string {
  try {
    const b = JSON.parse(r.body) as Record<string, unknown>;
    const c = b.error_code ?? b.code ?? b.error;
    return typeof c === "string" ? c : "";
  } catch {
    return "";
  }
}

/** Maps an auth response to a generic message. Never echoes server text (it can contain the email). */
export function authError(r: HttpResponse, action: "signin" | "signup" | "recover" | "verify" | "update" | "refresh"): AuthError {
  const code = errorCode(r);
  if (r.status === 429 || code.includes("rate_limit")) return new AuthError("Too many attempts. Please wait a little and try again.", "rate");
  if (code === "weak_password" || (action === "update" && r.status === 422 && code.includes("password")))
    return new AuthError("The server rejected this password as too weak. Choose a longer, less common one.", "weak");
  if (code === "same_password") return new AuthError("Choose a password you haven't used for this account.", "weak");
  if (r.status >= 500) return new AuthError("The account service is having trouble. Try again later.", "server");
  switch (action) {
    case "signin":
      return new AuthError("Couldn't sign in. Check your email and password, and confirm your email if you just signed up.", "invalid");
    case "verify":
      return new AuthError("That code is invalid or has expired. Request a new one.", "expired");
    case "refresh":
      return new AuthError("Your session has ended. Please sign in again.", "expired");
    case "update":
      return new AuthError("Couldn't change the password. Sign in again and retry.", "invalid");
    default:
      return new AuthError("Something went wrong. Please try again.", "server");
  }
}

// ---------------------------------------------------------------------------------------------
// Account state

export type AccountState =
  | { status: "loading" }
  | { status: "undecided" }
  | { status: "guest" }
  | { status: "signedIn"; userId: string; email?: string; offline?: boolean };

let state: AccountState = { status: "loading" };
let session: StoredSession | null = null;
const subs = new Set<() => void>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<StoredSession | null> | null = null;

function setState(s: AccountState) {
  state = s;
  subs.forEach((f) => f());
}

export const getAccount = () => state;
export function subscribeAccount(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}
export function useAccount(): AccountState {
  return useSyncExternalStore(subscribeAccount, getAccount);
}

const base = (path: string) => `${SUPABASE_URL}${path}`;
const authHeaders = (token?: string): Record<string, string> => ({
  apikey: SUPABASE_PUBLISHABLE_KEY,
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

async function request(path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}): Promise<HttpResponse> {
  try {
    return await http(base(path), {
      method: init.method ?? "GET",
      headers: { ...authHeaders(init.token), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      timeoutMs: 20000,
    });
  } catch (e) {
    if (String(e).includes("unsupported method")) throw new AuthError("unsupported method", "server");
    throw new AuthError("Couldn't reach the account service. Check your connection.", "network");
  }
}

async function persist(doc: AccountDoc) {
  await storeSave("account", doc);
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!session) return;
  const ms = Math.max(5_000, session.expires_at * 1000 - Date.now() - 90_000);
  refreshTimer = setTimeout(() => void refreshSession().catch(() => {}), Math.min(ms, 2 ** 31 - 1));
}

async function adoptSession(s: StoredSession) {
  session = s;
  await persist({ v: 1, session: s });
  scheduleRefresh();
  const claims = decodeJwt(s.access_token)!;
  const prevEmail = state.status === "signedIn" && state.userId === claims.sub ? state.email : undefined;
  setState({ status: "signedIn", userId: claims.sub, email: prevEmail });
}

async function dropSession(next: "undecided" | "guest") {
  clearTimeout(refreshTimer);
  session = null;
  await persist(next === "guest" ? { v: 1, guest: true } : { v: 1 });
  setState({ status: next });
}

export async function initAccount(): Promise<void> {
  let doc: AccountDoc | null = null;
  try {
    doc = parseAccountDoc((await storeLoad<unknown>("account")).value);
  } catch {
    doc = null;
  }
  if (doc?.session) {
    session = doc.session;
    const claims = decodeJwt(session.access_token)!;
    setState({ status: "signedIn", userId: claims.sub });
    if (isJwtExpired(session.access_token, Date.now(), 120)) await refreshSession().catch(() => {});
    else scheduleRefresh();
    void loadEmail();
  } else {
    setState({ status: doc?.guest ? "guest" : "undecided" });
  }
}

/** Refreshes the session (single flight). Signs out locally only when the server rejects the refresh token. */
export function refreshSession(): Promise<StoredSession | null> {
  if (refreshing) return refreshing;
  const current = session;
  if (!current) return Promise.resolve(null);
  refreshing = (async () => {
    let r: HttpResponse;
    try {
      r = await request("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: current.refresh_token } });
    } catch (e) {
      if (state.status === "signedIn") setState({ ...state, offline: true });
      scheduleRetry();
      throw e;
    }
    // Signed out (or into another account) while the request was out: the answer is for a
    // session that no longer exists, so it must neither sign back in nor sign the new one out.
    if (session !== current) return session;
    if (r.status >= 200 && r.status < 300) {
      const s = parseSession(safeJson(r.body));
      if (!s) throw new AuthError("Unexpected response from the account service.");
      await adoptSession(s);
      return s;
    }
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      void uiLog("warn", "account: session refresh rejected; signed out");
      await dropSession("undecided");
      throw authError(r, "refresh");
    }
    scheduleRetry();
    throw authError(r, "refresh");
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function scheduleRetry() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshSession().catch(() => {}), 60_000);
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** A valid access token, refreshing first when it is about to expire. */
export async function accessToken(): Promise<string> {
  if (!session) throw new AuthError("Not signed in.", "invalid");
  if (isJwtExpired(session.access_token, Date.now(), 60)) {
    const s = await refreshSession();
    if (!s) throw new AuthError("Not signed in.", "invalid");
    return s.access_token;
  }
  return session.access_token;
}

/** Authenticated request to the Supabase project (PostgREST or Auth). Retries once after a 401. */
export async function authedRequest(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<HttpResponse> {
  let r = await request(path, { ...init, token: await accessToken() });
  if (r.status === 401) {
    const s = await refreshSession();
    if (!s) return r;
    r = await request(path, { ...init, token: s.access_token });
  }
  if (state.status === "signedIn" && state.offline) setState({ ...state, offline: false });
  return r;
}

async function loadEmail() {
  try {
    const r = await authedRequest("/auth/v1/user");
    if (r.status !== 200) return;
    const u = safeJson(r.body) as { id?: unknown; email?: unknown } | null;
    if (state.status === "signedIn" && u && u.id === state.userId && typeof u.email === "string" && u.email.length <= 254) {
      setState({ ...state, email: u.email });
    }
  } catch {
    // offline: the email is cosmetic
  }
}

// --- sign-in backoff ---------------------------------------------------------------------------

let failures = 0;
let lockedUntil = 0;
/** Milliseconds until another sign-in attempt is allowed (0 = now). */
export const signInWaitMs = () => Math.max(0, lockedUntil - Date.now());
function noteFailure() {
  failures++;
  lockedUntil = Date.now() + backoffDelayMs(failures);
}

// --- flows -------------------------------------------------------------------------------------

function requireEmail(input: string): string {
  const e = normalizeEmail(input);
  if (!e) throw new AuthError("Enter a valid email address.", "invalid");
  return e;
}

export async function signIn(emailInput: string, password: string): Promise<void> {
  const email = requireEmail(emailInput);
  const wait = signInWaitMs();
  if (wait > 0) throw new AuthError(`Too many failed attempts. Try again in ${Math.ceil(wait / 1000)} s.`, "rate");
  if (!password) throw new AuthError("Enter your password.", "invalid");
  const r = await request("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
  if (r.status === 200) {
    const s = parseSession(safeJson(r.body));
    if (!s) throw new AuthError("Unexpected response from the account service.");
    failures = 0;
    lockedUntil = 0;
    await adoptSession(s);
    setState({ status: "signedIn", userId: decodeJwt(s.access_token)!.sub, email });
    return;
  }
  noteFailure();
  throw authError(r, "signin");
}

/**
 * Signs in without counting a failure: used while waiting for an email confirmation, where
 * "not confirmed yet" is expected. Resolves true once signed in.
 */
export async function trySignInAfterConfirm(emailInput: string, password: string): Promise<boolean> {
  const email = normalizeEmail(emailInput);
  if (!email || !password) return false;
  const r = await request("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
  if (r.status !== 200) return false;
  const s = parseSession(safeJson(r.body));
  if (!s) return false;
  await adoptSession(s);
  setState({ status: "signedIn", userId: decodeJwt(s.access_token)!.sub, email });
  return true;
}

/**
 * Signs in again with the account password, keeping the same account. Used before "Forgot PIN?":
 * for 5 minutes after a password sign-in the server lets a profile PIN be changed or removed
 * without the current PIN. The password is sent once and never kept.
 */
export async function reauthenticate(password: string): Promise<void> {
  if (state.status !== "signedIn") throw new AuthError("Not signed in.", "invalid");
  const userId = state.userId;
  const email = state.email ? normalizeEmail(state.email) : null;
  if (!email) throw new AuthError("Couldn't load your account details. Check your connection and try again.", "network");
  const wait = signInWaitMs();
  if (wait > 0) throw new AuthError(`Too many failed attempts. Try again in ${Math.ceil(wait / 1000)} s.`, "rate");
  if (!password) throw new AuthError("Enter your account password.", "invalid");
  const r = await request("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
  if (r.status === 200) {
    const s = parseSession(safeJson(r.body));
    if (!s || decodeJwt(s.access_token)?.sub !== userId) throw new AuthError("Unexpected response from the account service.");
    failures = 0;
    lockedUntil = 0;
    await adoptSession(s);
    setState({ status: "signedIn", userId, email });
    return;
  }
  noteFailure();
  if (r.status === 400 || r.status === 401) throw new AuthError("That password isn't right.", "invalid");
  throw authError(r, "signin");
}

/** Creates an account. Resolves "confirm" when Supabase sends a confirmation email (the normal case). */
export async function signUp(emailInput: string, password: string): Promise<"confirm" | "signedIn"> {
  const email = requireEmail(emailInput);
  const check = checkPassword(password, email);
  if (!check.ok) throw new AuthError(check.problems[0], "weak");
  const r = await request("/auth/v1/signup", { method: "POST", body: { email, password } });
  if (r.status === 200) {
    const s = parseSession(safeJson(r.body));
    if (s) {
      await adoptSession(s);
      return "signedIn";
    }
    return "confirm";
  }
  // An existing address gets the same answer as a new one, so sign-up can't be used to probe emails.
  const code = errorCode(r);
  if (code === "user_already_exists" || code === "email_exists") return "confirm";
  throw authError(r, "signup");
}

/** Confirms a sign-up with the 6-digit code from the email (only when the template includes {{ .Token }}). */
export async function verifySignupCode(emailInput: string, code: string): Promise<void> {
  await verify(emailInput, code, "signup");
}

/** Sends a password-recovery email. Always resolves the same way whether or not the address exists. */
export async function requestRecovery(emailInput: string): Promise<void> {
  const email = requireEmail(emailInput);
  const r = await request("/auth/v1/recover", { method: "POST", body: { email } });
  if (r.status === 429 || r.status >= 500) throw authError(r, "recover");
}

async function verify(emailInput: string, code: string, type: "signup" | "recovery") {
  const email = requireEmail(emailInput);
  const token = code.replace(/\s+/g, "");
  if (!/^\d{6,10}$/.test(token)) throw new AuthError("Enter the code from the email.", "invalid");
  const r = await request("/auth/v1/verify", { method: "POST", body: { type, email, token } });
  if (r.status !== 200) throw authError(r, "verify");
  const s = parseSession(safeJson(r.body));
  if (!s) throw new AuthError("Unexpected response from the account service.");
  await adoptSession(s);
  setState({ status: "signedIn", userId: decodeJwt(s.access_token)!.sub, email });
}

/** Completes a password reset: verifies the emailed code (which signs in), then sets the new password. */
export async function resetPassword(emailInput: string, code: string, newPassword: string): Promise<void> {
  const check = checkPassword(newPassword, emailInput);
  if (!check.ok) throw new AuthError(check.problems[0], "weak");
  await verify(emailInput, code, "recovery");
  await updatePassword(newPassword);
}

export async function updatePassword(newPassword: string): Promise<void> {
  const email = state.status === "signedIn" ? state.email : undefined;
  const check = checkPassword(newPassword, email);
  if (!check.ok) throw new AuthError(check.problems[0], "weak");
  const r = await authedRequest("/auth/v1/user", { method: "PUT", body: { password: newPassword } });
  if (r.status !== 200) throw authError(r, "update");
}

/** Signs out: revokes this session's refresh token on the server, then forgets it locally. */
export async function signOut(): Promise<void> {
  const s = session;
  if (s) {
    try {
      const token = isJwtExpired(s.access_token, Date.now(), 0) ? (await refreshSession())?.access_token : s.access_token;
      if (token) await request("/auth/v1/logout?scope=local", { method: "POST", token });
    } catch {
      // Offline: the local copy is still deleted; the refresh token expires server-side on its own.
    }
  }
  await dropSession("undecided");
}

export async function continueAsGuest(): Promise<void> {
  await dropSession("guest");
}

// --- screen requests (the Root gate in main.tsx shows these) -----------------------------------

type Screens = { auth: boolean; picker: false | "pick" | "manage" };
let screens: Screens = { auth: false, picker: false };
const screenSubs = new Set<() => void>();
function setScreens(s: Screens) {
  screens = s;
  screenSubs.forEach((f) => f());
}
export const showAuthScreen = (open = true) => setScreens({ ...screens, auth: open });
export const showProfilePicker = (mode: Screens["picker"] = "pick") => setScreens({ ...screens, picker: mode });
export function useScreens(): Screens {
  return useSyncExternalStore(
    (f) => {
      screenSubs.add(f);
      return () => screenSubs.delete(f);
    },
    () => screens,
  );
}
