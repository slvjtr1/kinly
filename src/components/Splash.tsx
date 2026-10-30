import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Launch animation: the Kinly wordmark rising out of a glowing swell (~3 s), then a fade.
 * Only transform/opacity animate. Click, Esc, Enter or Space skips it. With reduced motion it is a
 * 600 ms fade. It is purely visual: the app boots underneath it in parallel.
 */
export function Splash({ onDone, reduceMotion = false }: { onDone: () => void; reduceMotion?: boolean }) {
  const [reduced] = useState(
    () => reduceMotion || (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches),
  );
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);

  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    onDone();
  }, [onDone]);

  const skip = useCallback(() => {
    if (done.current) return;
    setLeaving(true);
    window.setTimeout(finish, 220);
  }, [finish]);

  useEffect(() => {
    const total = reduced ? 600 : 3000;
    const fade = reduced ? 300 : 500;
    const t1 = window.setTimeout(() => setLeaving(true), total - fade);
    const t2 = window.setTimeout(finish, total);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.removeEventListener("keydown", onKey);
    };
  }, [reduced, finish, skip]);

  return (
    <div className={`splash ${reduced ? "reduced" : ""} ${leaving ? "leaving" : ""}`} onClick={skip} role="img" aria-label="Kinly">
      <div className="splash-glow" />
      <div className="splash-sea" aria-hidden="true">
        {/* Each wave is two identical periods wide and slides by one period, so the loop is seamless. */}
        <svg className="splash-wave w1" viewBox="0 0 2880 320" preserveAspectRatio="none">
          <path d="M0 150 Q 360 90 720 150 T 1440 150 T 2160 150 T 2880 150 L 2880 320 L 0 320 Z" />
        </svg>
        <svg className="splash-wave w2" viewBox="0 0 2880 320" preserveAspectRatio="none">
          <path d="M0 190 Q 360 240 720 190 T 1440 190 T 2160 190 T 2880 190 L 2880 320 L 0 320 Z" />
        </svg>
        <svg className="splash-wave w3" viewBox="0 0 2880 320" preserveAspectRatio="none">
          <path d="M0 235 Q 360 205 720 235 T 1440 235 T 2160 235 T 2880 235 L 2880 320 L 0 320 Z" />
        </svg>
      </div>
      <div className="splash-mark">
        <span className="kin">Kin</span>
        <span className="ly">ly</span>
      </div>
      <div className="splash-line" />
    </div>
  );
}
