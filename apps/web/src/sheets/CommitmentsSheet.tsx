import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { addCalendarMonths, type CommitmentItem } from "@finance/domain";
import { ledgerApi } from "../api/client";
import { mockCommitmentsFor } from "../api/commitments-demo";
import { commitmentsQueryKey } from "../lib/query-keys";
import { monthKeyLabel } from "../lib/format";
import { Amt } from "../components/Amt";
import { Sheet } from "../components/Sheet";

// Preserve cents in this planning view so the displayed details reconcile with totals.
const mxn = (minor: number) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(minor/100);

export function CommitmentsSheet({ idToken, demoMode, now, onClose, onOpenEvent }: {
  readonly idToken: string;
  readonly demoMode: boolean;
  readonly now: Date;
  readonly onClose: () => void;
  readonly onOpenEvent: (id: string) => Promise<void>;
}) {
  const [startMonth, setStartMonth] = useState<string>();
  const [openingEvent, setOpeningEvent] = useState(false);
  const [eventError, setEventError] = useState<string>();
  const lede = useRef<HTMLParagraphElement>(null);
  const query = useQuery({ queryKey: commitmentsQueryKey(startMonth), queryFn: () => demoMode
    ? Promise.resolve(mockCommitmentsFor(now, startMonth)) : ledgerApi.commitments(idToken, startMonth) });
  const data = query.data;
  const firstMonth = data?.months[0]?.month;
  useEffect(() => { lede.current?.closest(".sheet")?.scrollTo({ top: 0 }); }, [firstMonth]);
  const openEvent = async (id: string) => {
    setOpeningEvent(true); setEventError(undefined);
    try { await onOpenEvent(id); }
    catch { setEventError("No pudimos abrir esta compra. Intenta de nuevo."); }
    finally { setOpeningEvent(false); }
  };
  const changePage = (month?: string) => { setStartMonth(month); setEventError(undefined); };
  const itemRow = (item: CommitmentItem) => (
    <div className="commitment-item" key={`${item.kind}-${item.id}`}>
      <div>
        {item.kind==="msi" ? <button type="button" className="text-button" disabled={openingEvent}
          onClick={() => void openEvent(item.id)}>{item.name} <span aria-hidden="true">↗</span></button> : <strong>{item.name}</strong>}
        <small>{item.kind==="msi" ? `Cuota ${item.installmentIndex}/${item.installments} · termina ${monthKeyLabel(item.endMonth!)}`
          : `Día ${item.dueDay} · cada mes`}{item.needsReview ? " · por confirmar" : ""}</small>
      </div>
      <strong><Amt>{mxn(item.amountMinor)}</Amt></strong>
    </div>
  );
  return (
    <Sheet title="Próximos compromisos" eyebrow="LO QUE YA TIENES PROGRAMADO" onClose={onClose} className="commitments-sheet">
      <p className="sheet-lede" ref={lede}>MSI pendientes y gastos fijos en MXN. Los gastos fijos muestran lo programado; no confirman si ya pagaste. No incluye nuevas compras ni estima ingresos.</p>
      {eventError ? <p role="alert" className="commitments-note">{eventError}</p> : null}
      {query.isPending ? <p role="status">Consultando tus próximos meses…</p> : query.isError ? (
        <div role="alert"><p>No pudimos consultar tus compromisos.</p>
          <button className="secondary-button" type="button" onClick={() => void query.refetch()}>Reintentar</button>
          {startMonth ? <button className="text-button" type="button" onClick={() => changePage()}>Volver al mes actual</button> : null}
        </div>
      ) : data ? <>
        {data.incompletePlans.length ? <aside className="commitments-note">
          <strong>Faltan calendarios MSI por completar</strong>
          <p>Estos planes están fuera del total. Tu compromiso puede ser mayor.</p>
          {data.incompletePlans.map(plan => <button className="text-button" type="button" key={plan.eventId}
            disabled={openingEvent} onClick={() => void openEvent(plan.eventId)}>{plan.name} · Revisar →</button>)}
        </aside> : null}
        <p className="commitments-range">{monthKeyLabel(data.months[0]!.month)} – {monthKeyLabel(data.months.at(-1)!.month)} · MXN</p>
        <div className="commitments-months">
          {data.months.map(month => <details className="commitment-month" key={month.month}>
            <summary>
              <span className="commitment-month-copy"><strong>{monthKeyLabel(month.month)}</strong>
                <small>{month.month===data.currentMonth ? "Este mes · MSI pendientes + fijos programados" : "Total comprometido"}</small>
                <small><Amt>{month.installmentCount}</Amt> {month.installmentCount===1 ? "cuota" : "cuotas"} · MSI <Amt>{mxn(month.msiMinor)}</Amt> · Fijos <Amt>{mxn(month.fixedMinor)}</Amt></small>
                {month.fixedSourceMonth===null ? <small>Sin gastos fijos configurados</small> : null}
                {month.changeMinor !== null && month.changeMinor !== 0 ? <small><Amt>{mxn(Math.abs(month.changeMinor))}</Amt> {month.changeMinor<0 ? "menos" : "más"} que el mes anterior</small> : null}
                {month.uncertainMinor>0 ? <small>Incluye <Amt>{mxn(month.uncertainMinor)}</Amt> por confirmar</small> : null}
              </span>
              <strong className="commitment-month-amount"><Amt>{mxn(month.totalMinor)}</Amt><span className="chevron" aria-hidden="true">⌄</span></strong>
            </summary>
            <div className="commitment-details">
              <h3>MSI pendientes</h3>
              {month.items.filter(item=>item.kind==="msi").length ? month.items.filter(item=>item.kind==="msi").map(itemRow)
                : <p>No hay cuotas pendientes registradas.</p>}
              <h3>Gastos fijos</h3>
              <p>{month.fixedSourceMonth===null ? "No tienes gastos fijos configurados para este periodo."
                : month.fixedSourceMonth===month.month ? "Según la configuración de este mes."
                  : `Según tus gastos fijos de ${monthKeyLabel(month.fixedSourceMonth)}; se repiten mientras no los cambies.`}</p>
              {month.items.filter(item=>item.kind==="fixed").map(itemRow)}
              {month.fixedSourceMonth!==null && !month.items.some(item=>item.kind==="fixed") ? <p>La lista configurada está vacía.</p> : null}
              {month.totalMinor===0 ? <p>No hay compromisos conocidos para este mes.</p> : null}
            </div>
          </details>)}
        </div>
        <nav className="commitments-pagination" aria-label="Periodo de compromisos">
          <button type="button" className="secondary-button" disabled={data.months[0]!.month===data.currentMonth}
            onClick={() => { const previous=addCalendarMonths(data.months[0]!.month,-12); changePage(previous<=data.currentMonth ? undefined : previous); }}>← Anteriores</button>
          <button type="button" className="secondary-button" disabled={!data.nextStartMonth}
            onClick={() => changePage(data.nextStartMonth)}>Siguientes 12 meses →</button>
        </nav>
      </> : null}
    </Sheet>
  );
}
