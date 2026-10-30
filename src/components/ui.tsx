import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Inbox, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MetaPreview } from "../lib/addons";
import { useApp } from "../state";
import { trapDialogFocus } from "../lib/spatialNav";

/**
 * A stable "open this title" callback for MetaCard. Stable props keep the memoised cards from
 * re-rendering when their row or grid re-renders (a page of new items, a hero arriving, a toast).
 */
export function useOpenMeta(fallbackType?: string): (m: MetaPreview) => void {
  const { navigate } = useApp();
  return useCallback((m: MetaPreview) => navigate({ name: "detail", type: m.type ?? fallbackType ?? "movie", id: m.id }), [navigate, fallbackType]);
}

export function Poster({ src, title, progress, badge, eager }: { src?: string; title: string; progress?: number; badge?: ReactNode; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="poster">
      {src && !failed ? (
        // Intrinsic 2:3 size so layout never waits for the file; decoded off the main thread.
        <img src={src} alt="" width={300} height={450} loading={eager ? "eager" : "lazy"} decoding="async" onError={() => setFailed(true)} />
      ) : (
        <div className="fallback">{title}</div>
      )}
      {badge && <div className="poster-badge">{badge}</div>}
      {progress != null && progress > 0 && (
        <div className="progress-bar">
          <i style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

export const MetaCard = memo(function MetaCard({ meta, onOpen, progress }: { meta: MetaPreview; onOpen: (m: MetaPreview) => void; progress?: number }) {
  return (
    <button className="card" onClick={() => onOpen(meta)} title={meta.name}>
      <Poster src={meta.poster} title={meta.name} progress={progress} badge={<ImdbRating value={meta.imdbRating} small />} />
      <div className="card-title">{meta.name}</div>
      <div className="card-sub">{meta.releaseInfo}</div>
    </button>
  );
});

export function WideCard({
  image,
  title,
  subtitle,
  progress,
  onOpen,
}: {
  image?: string;
  title: string;
  subtitle?: string;
  progress?: number;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <button className="wide-card" onClick={onOpen} title={title}>
      <div className="thumb">
        {image && !failed ? <img src={image} alt="" width={480} height={270} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : null}
        {progress != null && (
          <div className="progress-bar">
            <i style={{ width: `${Math.min(100, progress * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="card-title">{title}</div>
      {subtitle && <div className="card-sub">{subtitle}</div>}
    </button>
  );
}

/** Placeholder row: one composited layer pulses (not one per card), so it costs no repaints. */
export function RowSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="row skeleton-row" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-card">
          <div className="skeleton-poster" />
          <div className="skeleton-line" />
        </div>
      ))}
    </div>
  );
}

/** Placeholder poster grid for Browse and Search while the first page loads. */
export function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid skeleton-row" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-card">
          <div className="skeleton-poster" />
          <div className="skeleton-line" />
        </div>
      ))}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state" role="status">
      <div className="spinner" aria-hidden="true" />
      <div>{label}</div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <Inbox size={40} />
      <div style={{ fontWeight: 700, color: "var(--text)" }}>{title}</div>
      {children}
    </div>
  );
}

export function ErrorState({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="state">
      <AlertTriangle size={40} />
      <div style={{ fontWeight: 700, color: "var(--text)" }}>{title}</div>
      {detail && <div className="faint">{detail}</div>}
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

const PRISM_URL = "https://github.com/FortoGraphy/prism-download-manager";

/** The suggestion shown wherever downloads leave Kinly. */
export function PrismHint() {
  return (
    <span className="prism-hint">
      (We suggest using an open-source download manager, such as{" "}
      <a href={PRISM_URL} onClick={(e) => { e.preventDefault(); void openUrl(PRISM_URL); }}>Prism</a>.)
    </span>
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Modal({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => (box.current ? trapDialogFocus(box.current) : undefined), []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={box} className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** IMDb-style rating badge. */
export function ImdbRating({ value, small }: { value?: string | number; small?: boolean }) {
  if (value == null || value === "" || Number(value) <= 0) return null;
  return (
    <span className={`imdb ${small ? "small" : ""}`} title="IMDb rating">
      <b>IMDb</b>
      {Number(value).toFixed(1)}
    </span>
  );
}
