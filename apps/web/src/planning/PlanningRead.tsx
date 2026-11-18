import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Amt } from "../components/Amt";
import { exactMxn } from "../lib/format";

export type PlanningPane = "budget" | "income" | "goals";
export type PlanningAccess = { readonly idToken: string; readonly demoMode: boolean };

const shortDay = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const dayLabel = (day: string) => shortDay.format(new Date(`${day}T12:00:00Z`));
export const shortPercent = (value: number) => new Intl.NumberFormat("es-MX", { maximumFractionDigits: 1 }).format(value) + "%";

export function Amount({ value, unknown = "Por confirmar" }: { value: number | null; unknown?: string }) {
  return value === null ? <span className="plan-unknown">{unknown}</span> : <Amt>{exactMxn(value)}</Amt>;
}

export function PlanMetric({ label, value, negative = false, footnote }: {
  label: string; value: ReactNode; negative?: boolean; footnote?: ReactNode;
}) {
  return <div className="plan-metric">
    <dt>{label}</dt><dd className={negative ? "plan-negative" : undefined}>{value}
      {footnote && <span className="plan-meta plan-metric-note">{footnote}</span>}
    </dd>
  </div>;
}

export function ReadState({ label, failed, retry }: { label: string; failed?: boolean; retry?: () => void }) {
  return <div className="plan-read-state" role={failed ? "alert" : "status"}>
    <p>{label}</p>
    {retry && <button type="button" className="text-button plan-action" onClick={retry}>Reintentar</button>}
  </div>;
}

/** Ratios are only for drawing. Exact values remain visible as text beside the chart. */
export function PlanBar({ value, limit, marker, tone }: {
  value: number; limit: number; marker?: number; tone?: "over" | "watch";
}) {
  const extent = limit > 0 ? Math.max(0, Math.min(100, value / limit * 100)) : value > 0 ? 100 : 0;
  return <span className={`plan-bar amt ${tone ?? ""}`} aria-hidden="true">
    <span className="plan-bar-fill" style={{ width: `${extent}%` }} />
    {marker !== undefined && <span className="plan-bar-marker" style={{ left: `${Math.max(0, Math.min(100, marker))}%` }} />}
  </span>;
}

export function PlanningReadDialog({ title, onClose, suspended, children }: {
  title: string; onClose: () => void; suspended: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : null;
    return () => {
      const trigger = opener.current;
      // Wait until the dialog has left the top layer before restoring its trigger.
      queueMicrotask(() => {
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      });
    };
  }, []);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || suspended) return;
    dialog.showModal();
    if (focusedControl.current?.isConnected) focusedControl.current.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && dialog.contains(active)) focusedControl.current = active;
      dialog.close();
    };
  }, [suspended]);
  return <dialog ref={ref} className="planning-read-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="planning-read-inner">
      <header className="planning-read-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="close-button" onClick={onClose} aria-label="Cerrar">×</button>
      </header>
      {children}
    </div>
  </dialog>;
}

export function EvidenceButton({ label, onOpen }: {
  label: string; onOpen: (signal: AbortSignal) => Promise<void>;
}) {
  const request = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<"idle" | "opening" | "failed">("idle");
  useEffect(() => () => request.current?.abort(), []);
  const open = async () => {
    const controller = new AbortController();
    request.current = controller;
    setStatus("opening");
    try {
      await onOpen(controller.signal);
      if (!controller.signal.aborted) setStatus("idle");
    } catch {
      if (!controller.signal.aborted) setStatus("failed");
    }
  };
  return <div className="plan-evidence">
    <button type="button" className="text-button plan-action" disabled={status === "opening"} onClick={() => void open()}>
      {status === "opening" ? "Abriendo…" : label}
    </button>
    {status === "failed" && <p className="plan-meta plan-negative" role="alert">No pudimos abrir la evidencia. Intenta de nuevo.</p>}
  </div>;
}
