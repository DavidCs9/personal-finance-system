import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { addCalendarMonths, dayKeyInZone } from "@finance/domain";
import { ledgerApi } from "../api/client";
import { Amt } from "../components/Amt";
import { Sheet } from "../components/Sheet";
import { monthKeyLabel, timeZone } from "../lib/format";
import type {
  AmexImportPreview,
  AmexImportResult,
  StatementImportDecision,
  StatementImportCandidate,
  StatementImportRow,
} from "../types";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Provider = "amex" | "santander";

const statementMoney = (minor: number): string =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);

const candidateDayLabel = (value: string): string => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone }).format(date)
    : "Fecha no disponible";
};

const msiNeedsDecision = (row: StatementImportRow): boolean =>
  row.kind === "msi" && (row.status === "needs_decision" || row.status === "unplanned");

const msiReviewReason = (row: StatementImportRow): string => {
  if (row.reason === "ambiguous_msi_match") return "Más de un plan puede corresponder a esta cuota. Hace falta identificar cuál.";
  if (row.reason === "conflicting_msi_plan") return "Hay un plan que podría corresponder, pero la evidencia no permite vincularlo con seguridad. Revisa el plan y actualiza esta revisión si corriges sus datos.";
  if (row.reason === "incomplete_msi_schedule") {
    if (!Number.isInteger(row.installmentIndex) || !Number.isInteger(row.installmentMonths)
      || (row.installmentMonths ?? 0) < 1 || (row.installmentMonths ?? 0) > 48
      || (row.installmentIndex ?? 0) < 1 || (row.installmentIndex ?? 0) > (row.installmentMonths ?? 0)) {
      return "El estado no contiene un plazo completo para crear el plan. Falta identificar la cuota y el número de meses.";
    }
    if (!Number.isSafeInteger(row.originalAmountMinor) || (row.originalAmountMinor ?? 0) <= 0) {
      return "Falta una compra total válida en el estado. No podemos crear el plan automáticamente sin ese dato.";
    }
    return "El plazo, la cuota y la compra total leídos no forman un plan coherente. Revisa esos datos.";
  }
  return row.candidates?.length
    ? "No pudimos identificar un único plan para esta cuota. Revisa los candidatos."
    : "No pudimos resolver el plan con la información del estado. Revisa el plazo y la cuota.";
};

const rowActionLabel = (row: StatementImportRow, decision?: StatementImportDecision): string => {
  if (decision?.action === "skip") return "No se incorporará ahora";
  if (decision?.action === "confirm_msi") return "Se vinculará al plan elegido";
  if (decision?.action === "reconcile_plan") return "Se vinculará al plan manual con los datos del estado";
  if (decision?.action === "create_plan") return "Se creará el plan completado";
  if (decision?.action === "link") return "Se vinculará al movimiento elegido";
  if (decision?.action === "create") return "Se creará un movimiento distinto";
  if (row.status === "new") return row.kind === "msi" ? "Plan nuevo del estado" : "Se creará un movimiento";
  if (row.status === "matched") return row.kind === "msi" ? "Se vinculará al plan existente" : "Se vinculará al movimiento existente";
  if (msiNeedsDecision(row) || row.status === "ambiguous") return "Requiere revisión";
  if (row.status === "duplicate") return "Ya registrado · no se repetirá";
  return row.status === "excluded" ? "Fuera de gasto" : "Sin acción";
};

const decisionResolved = (decision: StatementImportDecision | undefined): boolean => {
  if (!decision) return false;
  if (decision.action === "skip" || decision.action === "create" || decision.action === "link") return true;
  if (decision.action === "confirm_msi") return Boolean(decision.eventId);
  if (decision.action === "reconcile_plan") return Boolean(decision.eventId && decision.expectedPlan);
  if (decision.action === "create_plan") {
    return Number.isInteger(decision.months) && Number.isInteger(decision.cuotaMinor);
  }
  return false;
};

export function ManualPlanComparison({ row, candidate, accountLastFour, selected, disabled, onSelect }: {
  readonly row: StatementImportRow;
  readonly candidate: StatementImportCandidate;
  readonly accountLastFour?: string;
  readonly selected?: StatementImportDecision;
  readonly disabled: boolean;
  readonly onSelect: (decision: StatementImportDecision) => void;
}) {
  const expected = candidate.expectedPlan;
  if (!candidate.canReconcilePlan || !expected || !row.originalOn || !accountLastFour
    || !Number.isInteger(row.installmentIndex) || !Number.isInteger(row.installmentMonths)
    || (row.installmentIndex ?? 0) < 1 || (row.installmentIndex ?? 0) > (row.installmentMonths ?? 0)
    || (row.installmentMonths ?? 0) > 48 || !Number.isSafeInteger(row.originalAmountMinor)
    || (row.originalAmountMinor ?? 0) <= 0 || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) return null;
  const startMonth = addCalendarMonths(row.occurredOn.slice(0, 7), -(row.installmentIndex! - 1));
  const chosen = selected?.action === "reconcile_plan" && selected.eventId === candidate.id;
  return <section className="statement-plan-comparison" aria-label={`Vincular plan manual ${candidate.merchantRaw}`}>
    <h4>Vincular el plan manual</h4>
    <p>Confirma la relación si corresponden a la misma compra. Al aplicar, el plan conservará su identidad e historial y usará los datos del estado.</p>
    <table>
      <caption>Datos del plan al aplicar</caption>
      <thead><tr><th scope="col">Dato</th><th scope="col">Plan manual</th><th scope="col">Estado de cuenta</th></tr></thead>
      <tbody>
        <tr><th scope="row">Compra total</th><td><Amt>{statementMoney(expected.principalMinor)}</Amt></td><td><Amt>{statementMoney(row.originalAmountMinor!)}</Amt></td></tr>
        <tr><th scope="row">Cuota</th><td><Amt>{statementMoney(expected.cuotaMinor)}</Amt></td><td><Amt>{statementMoney(row.amountMinor)}</Amt></td></tr>
        <tr><th scope="row">Plazo</th><td>{expected.months} meses</td><td>{row.installmentMonths} meses</td></tr>
        <tr><th scope="row">Inicio</th><td>{monthKeyLabel(expected.startMonth)}</td><td>{monthKeyLabel(startMonth)}</td></tr>
        <tr><th scope="row">Fecha de compra</th><td>{dayKeyInZone(new Date(expected.occurredAt))}</td><td>{row.originalOn}</td></tr>
        <tr><th scope="row">Tarjeta</th><td>{expected.accountLastFour ?? "Sin identificar"}</td><td>{accountLastFour}</td></tr>
      </tbody>
    </table>
    <p>Se conservará una sola compra. Esta cuota quedará vinculada a su plan y la relación quedará registrada para las próximas cuotas.</p>
    <button type="button" className="secondary-button" disabled={disabled || chosen}
      onClick={() => onSelect({ action: "reconcile_plan", eventId: candidate.id, expectedPlan: expected })}>
      {chosen ? "Vínculo preparado ✓" : "Vincular a este plan con los datos del estado"}
    </button>
  </section>;
}

export function StatementImportSheet({
  provider,
  idToken,
  initialImportId,
  onOpenEvent,
  onClose,
  onApplied,
}: {
  provider: Provider;
  idToken: string;
  initialImportId?: string;
  onOpenEvent?: (eventId: string, signal: AbortSignal) => Promise<void>;
  onClose(): void;
  onApplied(result: AmexImportResult): void;
}) {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<AmexImportPreview>();
  const [decisions, setDecisions] = useState<Readonly<Record<string, StatementImportDecision>>>({});
  const [planDrafts, setPlanDrafts] = useState<
    Readonly<Record<string, { months: string; cuota: string }>>
  >({});
  const [result, setResult] = useState<AmexImportResult>();
  const [busy, setBusy] = useState(Boolean(initialImportId));
  const [error, setError] = useState<string>();
  const [openingEvidence, setOpeningEvidence] = useState<{ id: string; status: "opening" | "failed" }>();
  const [refreshing, setRefreshing] = useState(false);
  const evidenceController = useRef<AbortController | undefined>(undefined);
  const cancelledRef = useRef(false);
  const ambiguous = preview?.rows?.filter((row) => row.status === "ambiguous") ?? [];
  const msiDecide = preview?.rows?.filter(msiNeedsDecision) ?? [];
  const unresolved =
    ambiguous.filter((row) => !decisionResolved(decisions[row.identity])).length
    + msiDecide.filter((row) => !decisionResolved(decisions[row.identity])).length;
  const label = provider === "amex" ? "Amex" : "Santander";
  const blocked = busy || refreshing;
  const newPlansCount = preview?.rows?.filter(row => row.kind === "msi"
    && (decisions[row.identity]?.action === "create_plan" || row.status === "new" && decisions[row.identity]?.action !== "skip")).length ?? 0;
  const newPurchasesCount = preview?.rows?.filter(row => row.kind === "purchase"
    && (decisions[row.identity]?.action === "create" || row.status === "new" && decisions[row.identity]?.action !== "skip")).length ?? 0;
  const linksCount = preview?.rows?.filter(row => {
    const action = decisions[row.identity]?.action;
    return action === "link" || action === "confirm_msi" || action === "reconcile_plan" || row.status === "matched" && action !== "skip";
  }).length ?? 0;

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      evidenceController.current?.abort();
    };
  }, []);

  const openEvidence = async (eventId: string) => {
    if (blocked || !onOpenEvent) return;
    evidenceController.current?.abort();
    const controller = new AbortController();
    evidenceController.current = controller;
    const isCurrent = () => !controller.signal.aborted && evidenceController.current === controller;
    setOpeningEvidence({ id: eventId, status: "opening" });
    try {
      await onOpenEvent(eventId, controller.signal);
      if (isCurrent()) setOpeningEvidence(undefined);
    } catch {
      if (isCurrent()) setOpeningEvidence({ id: eventId, status: "failed" });
    }
  };

  const waitUntilReady = useCallback(async (importId: string, isCancelled = () => cancelledRef.current): Promise<AmexImportPreview> => {
    for (let attempt = 0; attempt < 45; attempt += 1) {
      if (isCancelled()) throw new Error("Importación cancelada.");
      const status =
        provider === "amex"
          ? await ledgerApi.getAmexStatementImport(importId, idToken)
          : await ledgerApi.getSantanderStatementImport(importId, idToken);
      if (status.status === "ready" && status.rows) return status;
      await sleep(2_000);
    }
    throw new Error("Textract tardó demasiado. Intenta de nuevo en un momento.");
  }, [provider, idToken]);

  const refreshReview = async () => {
    if (!preview || blocked) return;
    evidenceController.current?.abort();
    setRefreshing(true);
    setError(undefined);
    try {
      const fresh = await waitUntilReady(preview.importId);
      if (cancelledRef.current) return;
      setPreview(fresh);
      setDecisions({});
      setPlanDrafts({});
      setOpeningEvidence(undefined);
    } catch (reason) {
      if (!cancelledRef.current) setError(reason instanceof Error ? reason.message : "No pudimos actualizar la revisión. Intenta de nuevo.");
    } finally {
      if (!cancelledRef.current) setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!initialImportId) return;
    let active = true;
    setBusy(true);
    void waitUntilReady(initialImportId, () => !active).then(ready => {
      if (active) setPreview(ready);
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "No pudimos recuperar la conciliación.");
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [initialImportId, waitUntilReady]);

  const inspect = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const started =
        provider === "amex"
          ? await ledgerApi.previewAmexStatement(file, idToken)
          : await ledgerApi.previewSantanderStatement(file, idToken);
      if (started.status === "ready" && started.rows) {
        setPreview(started);
        setDecisions({});
        setPlanDrafts({});
        return;
      }
      setPreview(started);
      const ready = await waitUntilReady(started.importId);
      if (!cancelledRef.current) {
        setPreview(ready);
        setDecisions({});
        setPlanDrafts({});
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : `No se pudo analizar el estado ${label}.`,
      );
      setPreview(undefined);
    } finally {
      if (!cancelledRef.current) setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview || preview.status !== "ready" || unresolved > 0 || blocked) return;
    setBusy(true);
    setError(undefined);
    try {
      const applied =
        provider === "amex"
          ? await ledgerApi.applyAmexStatement(preview.importId, decisions, idToken)
          : await ledgerApi.applySantanderStatement(preview.importId, decisions, idToken);
      setResult(applied);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : `No se pudo aplicar la conciliación ${label}.`,
      );
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Sheet
        eyebrow="CONCILIACIÓN TERMINADA"
        title={`Estado ${label} aplicado`}
        onClose={() => onApplied(result)}
      >
        <div className="import-result">
          <span className="result-mark">✓</span>
          <p>
            <strong>{result.summary.created}</strong> movimientos nuevos
          </p>
          <p>
            <strong>{result.summary.linked}</strong> conciliados
          </p>
          <p>
            <strong>{result.summary.msiConfirmed}</strong> cuotas MSI confirmadas
          </p>
          <p>
            <strong>{result.summary.skipped}</strong> omitidos
          </p>
          <button className="primary-button" onClick={() => onApplied(result)}>
            Ver movimientos
          </button>
        </div>
      </Sheet>
    );
  }

  const readyPreview =
    preview?.status === "ready" && preview.rows && preview.summary
      ? preview
      : undefined;

  return (
    <Sheet
      eyebrow={`ESTADO ${label.toUpperCase()}`}
      title="Conciliar periodo"
      onClose={onClose}
      className={readyPreview ? "statement-import-sheet sheet-split" : "statement-import-sheet"}
    >
      {initialImportId && busy && !readyPreview ? <p role="status">Recuperando la conciliación del PDF registrado…</p> : !readyPreview ? (
        <form className="sheet-form statement-upload-form" onSubmit={(event) => void inspect(event)}>
          <p>
            Sube el PDF del estado de cuenta. Olbia identifica movimientos ya registrados y planes
            existentes, y prepara los registros que faltan con los datos del PDF. Sólo pide revisión si hay datos incompletos o coincidencias que no puede resolver.
          </p>
          <label className="file-field">
            <span>Archivo PDF · máximo 50 MB</span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => setFile(event.target.files?.[0])}
            />
          </label>
          {preview?.status === "processing" && (
            <p className="form-hint">Leyendo el PDF con Textract… esto puede tomar un minuto.</p>
          )}
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" type="submit" disabled={!file || busy}>
            {busy ? "Analizando…" : "Analizar estado"}
          </button>
        </form>
      ) : (
        <div className="import-preview">
          <div className="statement-review-content">
          <div className="import-preview-head">
            <p className="import-account">
              {readyPreview.product} · {readyPreview.accountLastFour} · {readyPreview.period?.from} a{" "}
              {readyPreview.period?.to}
            </p>
            <div className="import-summary">
              <div>
                <strong>{newPurchasesCount}</strong>
                <span>Movimientos nuevos</span>
              </div>
              <div>
                <strong>{linksCount}</strong>
                <span>Se vincularán</span>
              </div>
              <div>
                <strong>{newPlansCount}</strong>
                <span>Planes nuevos</span>
              </div>
              <div className={unresolved ? "attention" : ""}>
                <strong>{unresolved}</strong>
                <span>Por revisar</span>
              </div>
            </div>
            <p className="import-note">Al aplicar, se vincularán las coincidencias únicas y se crearán los registros que faltan. Cada fila indica lo que ocurrirá.</p>
            <button type="button" className="text-button statement-refresh" disabled={blocked}
              onClick={() => void refreshReview()}>{refreshing ? "Actualizando revisión…" : "Actualizar revisión"}</button>
            {openingEvidence?.status === "opening" ? <p role="status" className="import-note">Abriendo movimiento y evidencia…</p> : null}
            {openingEvidence?.status === "failed" ? <div role="alert" className="import-note">
              <p>No pudimos abrir este movimiento. Intenta de nuevo.</p>
              <button type="button" className="text-button" disabled={blocked} onClick={() => void openEvidence(openingEvidence.id)}>Reintentar evidencia</button>
            </div> : null}
            {(readyPreview.summary?.excluded ?? 0) > 0 && (
              <p className="import-note">
                {readyPreview.summary?.excluded} pago o abono queda fuera del gasto.
              </p>
            )}
            {ambiguous.length > 0 && (
              <section className="ambiguous-list">
                <p className="eyebrow">MOVIMIENTOS QUE REQUIEREN REVISIÓN</p>
                {ambiguous.map((row) => (
                  <div className="ambiguous-row" key={row.identity}>
                    <div>
                      <strong>{row.merchantRaw}</strong>
                      <small>
                        {row.occurredOn} · <Amt>{statementMoney(row.amountMinor)}</Amt>
                      </small>
                      <small>Más de un movimiento coincide con los datos del estado. Elige el que corresponde o registra una compra distinta.</small>
                    </div>
                    <select
                      disabled={blocked}
                      aria-label={`Decisión para ${row.merchantRaw}`}
                      value={
                        decisions[row.identity]?.action === "create"
                          ? "create"
                          : decisions[row.identity]?.eventId ?? ""
                      }
                      onChange={(event) => {
                        const value = event.target.value;
                        setDecisions((current) => ({
                          ...current,
                          [row.identity]:
                            value === "create"
                              ? { action: "create" }
                              : { action: "link", eventId: value },
                        }));
                      }}
                    >
                      <option value="" disabled>
                        Elegir…
                      </option>
                      {(row.candidates ?? []).map((candidate) => (
                        <option value={candidate.id} key={candidate.id}>
                          Vincular: {candidate.merchantRaw}
                        </option>
                      ))}
                      <option value="create">Importar como nuevo</option>
                    </select>
                  </div>
                ))}
              </section>
            )}
            {msiDecide.length > 0 && (
              <section className="ambiguous-list">
                <p className="eyebrow">PLANES QUE REQUIEREN REVISIÓN</p>
                {msiDecide.map((row) => {
                  const draft = planDrafts[row.identity] ?? {
                    months: String(row.installmentMonths ?? ""),
                    cuota: (row.amountMinor / 100).toFixed(2),
                  };
                  const selected = decisions[row.identity];
                  const canCompletePlan = row.reason === "incomplete_msi_schedule";
                  return (
                    <div className="ambiguous-row" key={row.identity}>
                      <div>
                        <strong>{row.merchantRaw}</strong>
                        <small>
                          {row.occurredOn} · <Amt>{statementMoney(row.amountMinor)}</Amt>
                          {row.installmentIndex ? ` · cuota ${row.installmentIndex}` : ""}
                          {row.installmentMonths ? `/${row.installmentMonths}` : ""}
                          {row.originalAmountMinor ? (
                            <>
                              {" "}
                              · total <Amt>{statementMoney(row.originalAmountMinor)}</Amt>
                            </>
                          ) : null}
                        </small>
                        <small>{msiReviewReason(row)}</small>
                        {(row.candidates ?? []).map(candidate => <div className="statement-plan-candidate" key={candidate.id}>
                          <small>Plan registrado: {candidate.merchantRaw}
                          {candidate.months ? ` · ${candidate.months} meses` : ""}
                          {candidate.cuotaMinor !== undefined ? <> · cuota <Amt>{statementMoney(candidate.cuotaMinor)}</Amt></> : null}
                          {candidate.principalMinor !== undefined ? <> · compra total <Amt>{statementMoney(candidate.principalMinor)}</Amt></> : null}
                          {candidate.occurredAt ? ` · ${candidateDayLabel(candidate.occurredAt)}` : ""}
                          </small>
                          {onOpenEvent ? <button type="button" className="text-button" disabled={blocked || openingEvidence?.status === "opening"}
                            onClick={() => void openEvidence(candidate.id)}>Ver plan y evidencia</button> : null}
                          <ManualPlanComparison row={row} candidate={candidate} accountLastFour={readyPreview.accountLastFour}
                            selected={selected} disabled={blocked}
                            onSelect={decision => setDecisions(current => ({ ...current, [row.identity]: decision }))} />
                        </div>)}
                      </div>
                      <div className="msi-decide">
                        {row.reason === "ambiguous_msi_match" && (row.candidates ?? []).length > 0 && (
                          <select
                            disabled={blocked}
                            aria-label={`Confirmar MSI ${row.merchantRaw}`}
                            value={
                              selected?.action === "confirm_msi" || selected?.action === "link"
                                ? selected.eventId ?? ""
                                : ""
                            }
                            onChange={(event) => {
                              const eventId = event.target.value;
                              if (!eventId) return;
                              setDecisions((current) => ({
                                ...current,
                                [row.identity]: { action: "confirm_msi", eventId },
                              }));
                            }}
                          >
                            <option value="" disabled>
                              Confirmar en plan…
                            </option>
                            {(row.candidates ?? []).map((candidate) => (
                              <option value={candidate.id} key={candidate.id}>
                                {candidate.merchantRaw}
                              </option>
                            ))}
                          </select>
                        )}
                        {canCompletePlan && <>
                        <label>
                          Meses
                          <input
                            disabled={blocked}
                            type="number"
                            min={1}
                            max={48}
                            value={draft.months}
                            onChange={(event) =>
                              setPlanDrafts((current) => ({
                                ...current,
                                [row.identity]: { ...draft, months: event.target.value },
                              }))
                            }
                          />
                        </label>
                        <label>
                          Cuota
                          <input
                            disabled={blocked}
                            type="number"
                            min={0.01}
                            step={0.01}
                            value={draft.cuota}
                            onChange={(event) =>
                              setPlanDrafts((current) => ({
                                ...current,
                                [row.identity]: { ...draft, cuota: event.target.value },
                              }))
                            }
                          />
                        </label>
                        <button
                          type="button"
                          className="text-button"
                          disabled={blocked}
                          onClick={() => {
                            const months = Number(draft.months);
                            const cuotaMajor = Number(draft.cuota);
                            const cuotaMinor = Math.round(cuotaMajor * 100);
                            if (!Number.isInteger(months) || months < 1 || months > 48
                              || !Number.isSafeInteger(cuotaMinor) || cuotaMinor <= 0) return;
                            setDecisions((current) => ({
                              ...current,
                              [row.identity]: {
                                action: "create_plan",
                                months,
                                cuotaMinor,
                              },
                            }));
                          }}
                        >
                          {selected?.action === "create_plan" ? "Plan listo ✓" : "Completar y crear plan"}
                        </button>
                        </>}
                        <button
                          type="button"
                          className="text-button"
                          disabled={blocked}
                          onClick={() => {
                            setDecisions((current) => ({
                              ...current,
                              [row.identity]: { action: "skip" },
                            }));
                          }}
                        >
                          {selected?.action === "skip" ? "Sin incorporar ahora ✓" : "No incorporar esta cuota ahora"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            )}
          </div>
          <div className="import-preview-list payment-list" role="list">
            {(readyPreview.rows ?? []).map((row) => (
              <div key={row.identity} className="payment-row" style={{ cursor: "default" }} role="listitem">
                <span className="date-block">
                  <small>{row.kind === "msi" ? "MSI" : "CMP"}</small>
                  <strong>
                    {row.kind === "msi" && row.installmentIndex
                      ? String(row.installmentIndex).padStart(2, "0")
                      : row.occurredOn.slice(8, 10)}
                  </strong>
                </span>
                <span className="payment-name">
                  <strong>{row.merchantRaw}</strong>
                  <small>
                    {rowActionLabel(row, decisions[row.identity])}
                  </small>
                  {row.kind === "msi" && <small>
                    {row.occurredOn} · {" "}
                    {row.installmentIndex && row.installmentMonths ? `Cuota ${row.installmentIndex}/${row.installmentMonths}` : "Plazo incompleto"}
                    {row.originalAmountMinor ? <> · compra total <Amt>{statementMoney(row.originalAmountMinor)}</Amt></> : null}
                  </small>}
                </span>
                <strong className="payment-amount">
                  <Amt>{statementMoney(row.amountMinor)}</Amt>
                </strong>
              </div>
            ))}
          </div>
          </div>
          <div className="import-preview-footer">
            {error && <p className="form-error">{error}</p>}
            <button
              className="primary-button"
              type="button"
              disabled={blocked || unresolved > 0}
              onClick={() => void apply()}
            >
              {refreshing ? "Actualizando revisión…" : busy
                ? "Aplicando…"
                : unresolved > 0
                  ? `Revisa ${unresolved} ${unresolved === 1 ? "caso" : "casos"}`
                  : "Aplicar conciliación"}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
