// Frame-time and boot probe, compiled in only when the web build runs with VITE_PERF_PROBE=1
// (see main.tsx). It writes to the app log ("[ui] perf: ...") so runs can be compared.
import { uiLog } from "./lib/tauri";

const log = (m: string) => void uiLog("info", `perf: ${m}`);

function stats(d: number[]) {
  const s = [...d].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const avg = d.reduce((a, b) => a + b, 0) / (d.length || 1);
  return `frames=${d.length} avg=${avg.toFixed(1)} p50=${q(0.5).toFixed(1)} p95=${q(0.95).toFixed(1)} max=${(s[s.length - 1] ?? 0).toFixed(0)} >33=${d.filter((x) => x > 33.4).length} >50=${d.filter((x) => x > 50).length}`;
}

export function startPerfProbe() {
  log(`boot ${performance.now().toFixed(0)}ms`);

  // Large synchronous JSON.parse calls (IPC replies and addon bodies).
  const parse = JSON.parse;
  JSON.parse = function (text: string, reviver?: (k: string, v: unknown) => unknown) {
    const t = performance.now();
    const r = parse(text, reviver);
    const dt = performance.now() - t;
    if (dt > 4) log(`JSON.parse ${dt.toFixed(1)}ms ${(String(text).length / 1024).toFixed(0)}KB`);
    return r;
  } as typeof JSON.parse;

  const seen = new Set<string>();
  const mark = (name: string, sel: string) => {
    if (!seen.has(name) && document.querySelector(sel)) {
      seen.add(name);
      log(`${name} ${performance.now().toFixed(0)}ms`);
    }
  };
  const mo = new MutationObserver(() => {
    mark("first-skeleton", ".skeleton");
    mark("hero", ".hero-bg");
    mark("first-row", ".row .card");
    mark("first-poster-img", ".row .card img");
    if (seen.size >= 4) mo.disconnect();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // rAF probe: frame deltas per 2 s window, logged when something moved or stalled.
  let scrolls = 0;
  document.addEventListener("scroll", () => scrolls++, { capture: true, passive: true });
  let last = performance.now();
  let start = last;
  let deltas: number[] = [];
  const tick = (now: number) => {
    deltas.push(now - last);
    last = now;
    if (now - start >= 2000) {
      const stalled = deltas.some((x) => x > 50);
      if (scrolls > 0 || stalled) {
        const what = [
          document.querySelector(".spinner, .acct-spin, .kp-spin") ? "spinner" : "",
          document.querySelector(".skeleton") ? "skeleton" : "",
          document.querySelector(".sheet") ? "sheet" : "",
          document.querySelector(".detail-hero") ? "detail" : "",
          document.querySelector(".grid") ? "grid" : "",
          document.querySelector(".hero") ? "home" : "",
        ].filter(Boolean).join(",");
        log(`frames [${what}] scrolls=${scrolls} ${stats(deltas)}`);
      }
      deltas = [];
      scrolls = 0;
      start = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Main-thread heartbeat: a message posted every 50 ms that arrives late means the main thread
  // was busy (script, style, layout or painting). Gaps without a late heartbeat are the compositor.
  const where = () => (document.querySelector(".kp") ? "player" : document.querySelector(".hero") ? "home" : document.querySelector(".grid") ? "grid" : "other");
  let due = performance.now() + 50;
  const beat = () => {
    const late = performance.now() - due;
    if (late > 80) log(`main-thread blocked ~${late.toFixed(0)}ms [${where()}]`);
    due = performance.now() + 50;
    setTimeout(beat, 50);
  };
  setTimeout(beat, 50);

  // Ctrl+Alt+B: show a spinner and block the main thread for 3 s. Screenshots taken meanwhile
  // show whether the compositor keeps it turning without the main thread (GPU compositing).
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey && e.altKey && e.key.toLowerCase() === "b")) return;
    const el = document.createElement("div");
    el.className = "spinner";
    el.style.cssText = "position:fixed;left:50%;top:50%;width:120px;height:120px;border-width:12px;z-index:9999";
    document.body.appendChild(el);
    setTimeout(() => {
      log("busy-test start");
      const end = performance.now() + 3000;
      while (performance.now() < end) {
        /* block */
      }
      log("busy-test end");
      setTimeout(() => el.remove(), 1000);
    }, 500);
  });
}
