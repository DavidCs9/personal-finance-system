import { useEffect, useRef, useState } from "react";
import type { MonthMsiRow } from "@finance/domain";
import type { CardCycle } from "../card-cycle";
import type { PlannedPayment } from "../monthly-plan";
import { money, monthKey, monthKeyLabel } from "../lib/format";
import { Amt } from "../components/Amt";
import { CardCycleSection } from "../components/CardCycleSection";
import { FixedPaymentsSection } from "../components/FixedPaymentsSection";
import { MsiMonthSection } from "../components/MsiMonthSection";

export interface PlanningViewProps {
  readonly month: string;
  readonly now: Date;
  readonly monthMsiRows: readonly MonthMsiRow[];
  readonly msiSpentMinor: number;
  readonly msiCommittedMinor: number;
  readonly msiLoading: boolean;
  readonly msiLoadError?: string;
  readonly onRetryMsi: () => void;
  readonly onOpenMsiEvent: (eventId: string, signal: AbortSignal) => Promise<void>;
  readonly fixedPayments: readonly PlannedPayment[];
  readonly inheritedFromMonth?: string;
  readonly billUpcomingMinor?: number;
  readonly fixedPaymentsLoading: boolean;
  readonly fixedPaymentsLoadError?: string;
  readonly onRetryFixedPayments: () => void;
  readonly onAddPayment: () => void;
  readonly onEditPayment: (payment: PlannedPayment) => void;
  readonly cards: readonly CardCycle[];
  readonly cardsLoading: boolean;
  readonly cardsLoadError?: string;
  readonly onRetryCards: () => void;
  readonly onAddCard: () => void;
  readonly onEditCard: (card: CardCycle) => void;
  readonly onOpenCommitments: () => void;
  readonly onOpenStatements: () => void;
}

type EventOpening = {
  readonly month: string;
  readonly id: string;
  readonly signal: AbortSignal;
  readonly status: "opening" | "failed";
};

export function PlanningView(props: PlanningViewProps) {
  const [eventOpening, setEventOpening] = useState<EventOpening>();
  const openingController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => {
    openingController.current?.abort();
    openingController.current = undefined;
  }, [props.month]);
  const currentOpening = eventOpening?.month === props.month && !eventOpening.signal.aborted
    ? eventOpening : undefined;
  const openMsiEvent = async (id: string) => {
    openingController.current?.abort();
    const controller = new AbortController();
    openingController.current = controller;
    const context = { month: props.month, id, signal: controller.signal };
    const isCurrent = () => !controller.signal.aborted && openingController.current === controller;
    setEventOpening({ ...context, status: "opening" });
    try {
      await props.onOpenMsiEvent(id, controller.signal);
      if (isCurrent()) setEventOpening(undefined);
    } catch {
      if (isCurrent()) setEventOpening({ ...context, status: "failed" });
    }
  };

  return (
    <section className="planning-view">
      <div className="planning-scroll">
        <header className="planning-heading">
          <p className="eyebrow">LO QUE TIENES PROGRAMADO</p>
          <h1>Planificación</h1>
          <p>MSI, gastos fijos y fechas de {monthKeyLabel(props.month)}, el mes elegido.</p>
        </header>

        {currentOpening?.status === "opening" ? <p role="status">Abriendo compra…</p> : null}
        {currentOpening?.status === "failed" ? (
          <div role="alert" className="planning-event-error">
            <p>No pudimos abrir esta compra. Intenta de nuevo.</p>
            <button type="button" className="text-button" onClick={() => void openMsiEvent(currentOpening.id)}>
              Volver a abrir compra
            </button>
          </div>
        ) : null}

        <section className="planning-section planning-msi-section">
          <details key={props.month} className="planning-disclosure">
            <summary className="planning-section-summary">
              <span className="planning-section-copy">
                <span className="eyebrow">MESES SIN INTERESES</span>
                <strong role="heading" aria-level={2}>Planes con fin</strong>
                {props.msiLoading ? <span role="status">Consultando tus cuotas MSI…</span>
                  : props.msiLoadError ? <small>Cuotas no disponibles</small>
                    : <small><Amt>{props.monthMsiRows.length}</Amt> {props.monthMsiRows.length === 1 ? "cuota del mes" : "cuotas del mes"}</small>}
              </span>
              <span className="planning-section-value">
                {!props.msiLoading && !props.msiLoadError ? <span className="planning-msi-amounts">
                  <small>Registradas <Amt>{money(props.msiSpentMinor)}</Amt></small>
                  <small>Comprometidas <Amt>{money(props.msiCommittedMinor)}</Amt></small>
                </span> : null}
                <span className="planning-chevron" aria-hidden="true">⌄</span>
              </span>
            </summary>
            {!props.msiLoading && !props.msiLoadError ? (
              <div className="planning-section-content">
                {props.monthMsiRows.length ? <MsiMonthSection rows={props.monthMsiRows}
                  msiSpentMinor={props.msiSpentMinor} msiCommittedMinor={props.msiCommittedMinor}
                  showTotals embedded onOpen={id => void openMsiEvent(id)} />
                  : <p>No hay cuotas MSI registradas para este mes.</p>}
              </div>
            ) : null}
          </details>
          {props.msiLoadError && !props.msiLoading ? <div role="alert" className="planning-section-error">
            <p>{props.msiLoadError}</p>
            <button type="button" className="text-button" onClick={props.onRetryMsi}>Reintentar MSI</button>
          </div> : null}
        </section>

        <FixedPaymentsSection month={props.month} payments={props.fixedPayments}
          inheritedFromMonth={props.inheritedFromMonth} totalMinor={props.billUpcomingMinor}
          loading={props.fixedPaymentsLoading} loadError={props.fixedPaymentsLoadError}
          onRetry={props.onRetryFixedPayments} onAdd={props.onAddPayment} onEdit={props.onEditPayment} />

        <section className="commitments-preview">
          <button type="button" className="commitments-entry" onClick={props.onOpenCommitments}>
            <span><span className="eyebrow">PRÓXIMOS COMPROMISOS</span>
              <strong>Lo que ya tienes programado</strong>
              <small>Desde {monthKeyLabel(monthKey(props.now))}, el mes actual · periodos de 12 meses</small>
              <small>Este horizonte parte de hoy, aunque elijas otro mes.</small>
            </span>
            <span className="chevron" aria-hidden="true">→</span>
          </button>
        </section>

        <CardCycleSection month={props.month} now={props.now} cards={props.cards}
          loading={props.cardsLoading} loadError={props.cardsLoadError} onRetry={props.onRetryCards}
          onAdd={props.onAddCard} onEdit={props.onEditCard} />

        <section className="planning-statements">
          <button type="button" className="summary-shortcut" onClick={props.onOpenStatements}>
            <span>
              <strong>Estados de cuenta</strong>
              <small>PDF y cortes faltantes por mes · todas las fechas</small>
            </span>
            <span className="chevron" aria-hidden="true">→</span>
          </button>
        </section>
      </div>
    </section>
  );
}
