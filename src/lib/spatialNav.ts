// Keyboard and TV-remote navigation for the whole UI, in one place instead of per screen:
// - Arrow keys (D-pad) move focus to the nearest focusable element in that direction
//   (`pickNext`, pure and unit tested), scrolling rows and pages to keep it in view.
// - Enter/OK activates (native for buttons and links; role="button" etc. are clicked).
// - Back (Escape, the BrowserBack/GoBack keys, webOS key 461) leaves a text field first, then goes
//   back a view. Dialogs keep handling their own Escape.
// - When a dialog is open, focus moves only inside the topmost one (`[aria-modal="true"]`,
//   `[role="dialog"]` or `[data-nav-scope]`); Escape or its Close button leaves it, so it is never
//   a trap.
// - If the focused element disappears (content reloaded), the next arrow press continues from
//   the closest element to where it was.
// Widgets that use arrow keys themselves (text fields, sliders, selects) keep them where it
// matters; `data-nav="native"` on an element opts it and its children out entirely.

export type Dir = "up" | "down" | "left" | "right";
export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * How good a move from `from` to `to` in `dir` is (lower is better), or null when `to` is not in
 * that direction (it must start beyond the middle of `from`, so a neighbour slightly lower in the
 * same row is not "down"). Distance along the direction counts, but being out of line counts much more,
 * so "down" from a card picks the card below rather than a closer one diagonally.
 */
export function navScore(from: Box, to: Box, dir: Dir): number | null {
  const fcx = (from.left + from.right) / 2;
  const fcy = (from.top + from.bottom) / 2;
  const tcx = (to.left + to.right) / 2;
  const tcy = (to.top + to.bottom) / 2;
  const horizontal = dir === "left" || dir === "right";
  // A field with a button inside it (search box and its clear button): the field is still to the
  // button's left, though its box starts before the button's middle.
  const contains = to.left <= from.left && to.right >= from.right && to.top <= from.top && to.bottom >= from.bottom;
  let ahead: number;
  switch (dir) {
    case "right":
      if (tcx <= fcx + 1 || (to.left < fcx && !contains)) return null;
      ahead = Math.max(0, to.left - from.right);
      break;
    case "left":
      if (tcx >= fcx - 1 || (to.right > fcx && !contains)) return null;
      ahead = Math.max(0, from.left - to.right);
      break;
    case "down":
      if (tcy <= fcy + 1 || (to.top < fcy && !contains)) return null;
      ahead = Math.max(0, to.top - from.bottom);
      break;
    case "up":
      if (tcy >= fcy - 1 || (to.bottom > fcy && !contains)) return null;
      ahead = Math.max(0, from.top - to.bottom);
      break;
  }
  // Gap between the two boxes across the direction (0 when they overlap), and centre offset.
  const gap = horizontal
    ? Math.max(0, Math.max(from.top, to.top) - Math.min(from.bottom, to.bottom))
    : Math.max(0, Math.max(from.left, to.left) - Math.min(from.right, to.right));
  const offset = horizontal ? Math.abs(tcy - fcy) : Math.abs(tcx - fcx);
  return ahead + gap * 6 + offset * 0.25;
}

/** The best candidate in `dir` from `from`, or null. */
export function pickNext<T>(from: Box, candidates: { box: Box; item: T }[], dir: Dir): T | null {
  let best: T | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const s = navScore(from, c.box, dir);
    if (s != null && s < bestScore) {
      bestScore = s;
      best = c.item;
    }
  }
  return best;
}

/** The candidate whose centre is closest to `box` (used when the focused element went away). */
export function closest<T>(box: Box, candidates: { box: Box; item: T }[]): T | null {
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  let best: T | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = Math.hypot((c.box.left + c.box.right) / 2 - cx, (c.box.top + c.box.bottom) / 2 - cy);
    if (d < bestD) {
      bestD = d;
      best = c.item;
    }
  }
  return best;
}

export const ARROWS: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
/** Remote-control Back keys: Android TV / browsers (GoBack, BrowserBack), LG webOS (keyCode 461). */
export const isBackKey = (e: Pick<KeyboardEvent, "key" | "keyCode">) => e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack" || e.keyCode === 461;

// ---------------------------------------------------------------------------------------------
// DOM side

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[role=button]:not([aria-disabled=true])",
].join(",");
const SCOPES = "[aria-modal='true'],[role='dialog'],[data-nav-scope]";
const TEXT_TYPES = new Set(["text", "search", "url", "email", "password", "number", "tel", ""]);

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

function usable(el: HTMLElement): boolean {
  if (el.closest("[inert],[aria-hidden='true'],[data-nav='skip']")) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && st.display !== "none";
}

/** The topmost open dialog (focus stays inside it), or the document. */
export function navScope(doc: Document = document): ParentNode {
  const scopes = [...doc.querySelectorAll<HTMLElement>(SCOPES)].filter((s) => s.getClientRects().length > 0);
  return scopes[scopes.length - 1] ?? doc;
}

export function focusables(scope: ParentNode = navScope()): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(usable);
}

/** Whether the focused element should keep this arrow key for itself. */
function keepsArrow(el: Element | null, dir: Dir): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.closest("[data-nav='native']")) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLSelectElement) return dir === "up" || dir === "down";
  if (el instanceof HTMLInputElement) {
    if (el.type === "range") return dir === "left" || dir === "right";
    if (TEXT_TYPES.has(el.type)) {
      if (dir === "up" || dir === "down") return false;
      // The caret moves inside the text; at either end the arrow leaves the field.
      const s = el.selectionStart;
      const e = el.selectionEnd;
      if (s == null || e == null) return false;
      return dir === "left" ? !(s === 0 && e === 0) : !(s === el.value.length && e === el.value.length);
    }
  }
  return el.isContentEditable;
}

const isTyping = (el: Element | null) =>
  el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);

let lastBox: Box | null = null;
let keyboardMode = false;

/**
 * Keyboard mode also sets `data-nav="keys"` on <html>, which the focus styles use: browsers do not
 * always show :focus-visible when script moves focus after a mouse click (WebView2 does not).
 */
function setKeyboardMode(on: boolean) {
  if (on === keyboardMode) return;
  keyboardMode = on;
  if (on) document.documentElement.dataset.nav = "keys";
  else delete document.documentElement.dataset.nav;
}

/** True after keyboard or remote input, until the next pointer input. */
export const usingKeyboard = () => keyboardMode;

export function focusElement(el: HTMLElement) {
  // `focusVisible` is honoured where supported; data-nav="keys" covers the rest.
  el.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
  const reduce = document.documentElement.dataset.reduceMotion === "true" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
  lastBox = boxOf(el);
}

/** Moves focus one step in `dir` within the current scope. Returns false when nothing is there. */
export function moveFocus(dir: Dir): boolean {
  const scope = navScope();
  const list = focusables(scope);
  const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const inScope = active && (scope === document || (scope as HTMLElement).contains(active));
  const candidates = list.filter((el) => el !== active).map((el) => ({ box: boxOf(el), item: el }));
  let next: HTMLElement | null;
  if (active && inScope) next = pickNext(boxOf(active), candidates, dir);
  else if (lastBox && scope === document) next = closest(lastBox, candidates);
  else next = candidates[0]?.item ?? null;
  if (!next) return false;
  focusElement(next);
  return true;
}

export type NavOptions = {
  /** False while something else owns the keyboard (the player). */
  enabled: () => boolean;
  /** Called for Back when no dialog is open and no text field has focus. Returns false if there is nowhere to go back to. */
  onBack: () => boolean;
};

/** Installs the app-wide handler; returns its uninstaller. */
export function installSpatialNav(opts: NavOptions): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) setKeyboardMode(true);
    if (e.key !== "Escape" && isBackKey(e)) {
      // A remote's Back key acts exactly like Escape everywhere (dialogs, the player, sheets),
      // so every Escape handler in the app serves remotes too.
      e.preventDefault();
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      return;
    }
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !opts.enabled()) return;
    const active = document.activeElement;
    const dir = ARROWS[e.key];
    if (dir) {
      if (e.shiftKey || keepsArrow(active, dir)) return;
      if (moveFocus(dir)) e.preventDefault();
      return;
    }
    if (e.key === "Enter" && active instanceof HTMLElement && !(active instanceof HTMLButtonElement) && !(active instanceof HTMLAnchorElement)) {
      const role = active.getAttribute("role");
      if (role && ["button", "link", "tab", "radio", "option", "menuitem", "switch"].includes(role)) {
        e.preventDefault();
        active.click();
      }
      return;
    }
    if (isBackKey(e)) {
      if (isTyping(active)) {
        // Back first leaves the text field, so a remote can get out of it.
        if (e.key !== "Escape" || !(active instanceof HTMLInputElement) || !active.value) {
          (active as HTMLElement).blur();
          e.preventDefault();
        }
        return;
      }
      if (navScope() !== document) return; // the dialog closes itself
      if (opts.onBack()) e.preventDefault();
    }
  };
  const onPointer = () => setKeyboardMode(false);
  const onFocus = (e: FocusEvent) => {
    if (e.target instanceof HTMLElement && e.target !== document.body) lastBox = boxOf(e.target);
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("focusin", onFocus);
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("focusin", onFocus);
  };
}

// ---------------------------------------------------------------------------------------------
// Focus memory per view, so Back returns to the card you came from.

/** What kind of element it was (tag and first class), its label, and where it was in the page. */
export type FocusMark = { kind: string; label: string; index: number };
type Described = { kind: string; label: string };

const labelOf = (el: HTMLElement) => (el.getAttribute("aria-label") || el.title || el.textContent || "").trim().slice(0, 80);
const kindOf = (el: HTMLElement) => `${el.tagName}.${(el.getAttribute("class") ?? "").trim().split(/\s+/)[0]}`;

const allFocusable = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];

/** Describes `el` so it can be found again after its view is re-created (cheap: no layout reads). */
export function markFocus(el: Element | null = document.activeElement): FocusMark | null {
  if (!(el instanceof HTMLElement) || el === document.body) return null;
  const index = allFocusable(document).indexOf(el);
  return index < 0 ? null : { kind: kindOf(el), label: labelOf(el), index };
}

/**
 * Which of `list` is the element `mark` describes: same kind and label, nearest to its old
 * position (the same title can appear twice, e.g. in the hero and in a row). With `final`, an
 * element of the same kind nearest the old position will do. -1 when nothing fits.
 */
export function findMarked(list: Described[], mark: FocusMark, final = false): number {
  let best = -1;
  let bestScore = Infinity;
  list.forEach((d, i) => {
    if (d.kind !== mark.kind) return;
    const exact = !!mark.label && d.label === mark.label;
    if (!exact && !final) return;
    const score = Math.abs(i - mark.index) + (exact ? 0 : 1e6);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * Focuses the element described by `mark` once it exists (views load their content
 * asynchronously), trying for up to `timeoutMs`. Stops if something else gets focus first.
 */
export function restoreFocus(mark: FocusMark, timeoutMs = 4000): () => void {
  const started = Date.now();
  let timer = 0;
  const attempt = () => {
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== document.body) return;
    const final = Date.now() - started >= timeoutMs;
    // Indexes as in markFocus (all focusables); hidden ones are given no kind, so they never match.
    const list = allFocusable(document);
    const i = findMarked(list.map((el) => ({ kind: kindOf(el) === mark.kind && usable(el) ? mark.kind : "", label: labelOf(el) })), mark, final);
    if (i >= 0) {
      focusElement(list[i]);
      return;
    }
    if (!final) timer = window.setTimeout(attempt, 150);
  };
  timer = window.setTimeout(attempt, 60);
  return () => window.clearTimeout(timer);
}

/**
 * For dialogs and sheets: moves focus into `el` when it opens (to `[data-autofocus]` or the first
 * focusable) unless it already has it, keeps Tab cycling inside, and puts focus back where it was
 * when it closes.
 */
export function trapDialogFocus(el: HTMLElement): () => void {
  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!el.contains(document.activeElement)) {
    const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(el)[0];
    first?.focus({ preventScroll: true });
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const list = focusables(el);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      list[list.length - 1].focus();
    } else if (!e.shiftKey && i === list.length - 1) {
      e.preventDefault();
      list[0].focus();
    }
  };
  el.addEventListener("keydown", onKey);
  return () => {
    el.removeEventListener("keydown", onKey);
    if (prev && prev.isConnected && !el.contains(prev)) prev.focus({ preventScroll: true });
  };
}
