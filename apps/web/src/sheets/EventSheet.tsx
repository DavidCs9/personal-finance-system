import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { defaultCuotaMinor, monthKeyInZone, replaceMsiSchedule, addCalendarMonths } from "@finance/domain";
import { ledgerApi } from "../api/client";
import { Amt } from "../components/Amt";
import { Mark } from "../components/Brand";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";
import {
  eventDate,
  eventMoney,
  institutionLabel,
  longDateFormatter,
  money,
  statusLabel,
} from "../lib/format";
import { eventsQueryRoot, monthlySummaryQueryRoot } from "../lib/query-keys";
import type { EventFeed, PurchaseEvent } from "../types";

export function EventSheet({
  event,
  idToken,
  demoMode,
  onClose,
  onVerified,
}: {
  event: PurchaseEvent;
  idToken: string;
  demoMode: boolean;
  onClose(): void;
  onVerified(event: PurchaseEvent): void;
}) {
  const queryClient = useQueryClient();
  const [rawEmail, setRawEmail] = useState<string>();
  const [error, setError] = useState<string>();
  const [msiEnabled, setMsiEnabled] = useState(Boolean(event.msi));
  const [msiMonths, setMsiMonths] = useState(String(event.msi?.months ?? 3));
  const [msiCuota, setMsiCuota] = useState(
    ((event.msi?.cuotaMinor ?? defaultCuotaMinor(event.amount.amountMinor, event.msi?.months ?? 3)) / 100).toFixed(2),
  );
  const [categoryId, setCategoryId] = useState(event.categoryId ?? "");
  const [personalAmount, setPersonalAmount] = useState(
    event.personalAmountMinor === undefined ? "" : (event.personalAmountMinor / 100).toFixed(2),
  );
  const [categories, setCategories] = useState<readonly { id: string; name: string }[]>([]);

  useEffect(() => {
    setRawEmail(undefined);
    setError(undefined);
    setMsiEnabled(Boolean(event.msi));
    setMsiMonths(String(event.msi?.months ?? 3));
    setMsiCuota(
      (
        (event.msi?.cuotaMinor ??
          defaultCuotaMinor(event.amount.amountMinor, event.msi?.months ?? 3)) /
        100
      ).toFixed(2),
    );
    setCategoryId(event.categoryId ?? "");
    setPersonalAmount(
      event.personalAmountMinor === undefined ? "" : (event.personalAmountMinor / 100).toFixed(2),
    );
  }, [event.id, event.msi, event.amount.amountMinor, event.categoryId, event.personalAmountMinor]);

  useEffect(() => {
    if (demoMode) {
      setCategories([
        { id: "restaurantes", name: "Restaurantes" },
        { id: "transporte", name: "Transporte" },
        { id: "otros", name: "Otros" },
      ]);
      return;
    }
    void ledgerApi.listCategories(idToken).then((result) => {
      setCategories(result.categories);
    }).catch(() => {
      setCategories([]);
    });
  }, [demoMode, idToken]);

  const updateCache = (updated: PurchaseEvent) => {
    const spendMonth = monthKeyInZone(eventDate(updated));
    // The mutation response is authoritative. Keep every cached month coherent
    // locally instead of refetching all of them, including MSI cuota months.
    for (const [queryKey, current] of queryClient.getQueriesData<EventFeed>({ queryKey: eventsQueryRoot })) {
      const month = queryKey[1];
      if (!current || typeof month !== "string") continue;
      const isSpendMonth = month === spendMonth;
      const hasInstallment = updated.msi?.installments.some((item) => item.month === month) ?? false;
      queryClient.setQueryData<EventFeed>(queryKey, {
        ...current,
        events: current.events.map((item) => (item.id === updated.id ? updated : item)),
        msiRelated: [
          ...current.msiRelated.filter((item) => item.id !== updated.id),
          ...(!isSpendMonth && hasInstallment ? [updated] : []),
        ],
      });
    }
    void queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot });
    onVerified(updated);
    setMsiEnabled(Boolean(updated.msi));
    if (updated.msi) {
      setMsiMonths(String(updated.msi.months));
      setMsiCuota((updated.msi.cuotaMinor / 100).toFixed(2));
    }
  };

  const verifyMutation = useMutation({
    mutationFn: () =>
      demoMode
        ? Promise.resolve({ ...event, status: "accepted" as const, parseWarnings: [] })
        : ledgerApi.markVerified(event.id, idToken),
    onSuccess: updateCache,
  });

  const rejectMutation = useMutation({
    mutationFn: () =>
      demoMode
        ? Promise.resolve({ ...event, status: "rejected" as const })
        : ledgerApi.markRejected(event.id, idToken),
    onSuccess: updateCache,
  });

  const msiMutation = useMutation({
    mutationFn: async () => {
      if (!msiEnabled) {
        if (demoMode) return { ...event, msi: undefined };
        return ledgerApi.updateEventMsi(event.id, { action: "clear_msi" }, idToken);
      }
      const months = Number(msiMonths);
      const cuotaMinor = Math.round(Number(msiCuota) * 100);
      if (!Number.isInteger(months) || months < 1) throw new Error("Indica un número de meses válido.");
      if (!Number.isSafeInteger(cuotaMinor) || cuotaMinor <= 0) throw new Error("Indica una cuota válida.");
      if (demoMode) {
        const startMonth = monthKeyInZone(eventDate(event));
        const plan = replaceMsiSchedule(event.msi, {
          principalMinor: event.amount.amountMinor,
          months,
          startMonth,
          origin: event.msi?.origin === "amex_auto" ? "amex_auto" : "manual",
          cuotaMinor,
        });
        return { ...event, msi: { ...plan, needsScheduleCompletion: undefined } };
      }
      if (event.msi?.needsScheduleCompletion) {
        const spent = event.msi.installments.find((item) => item.status === "spent");
        const startMonth = spent
          ? addCalendarMonths(spent.month, -(spent.index - 1))
          : (event.msi.installments[0]?.month ?? monthKeyInZone(eventDate(event)));
        return ledgerApi.updateEventMsi(
          event.id,
          {
            action: "complete_msi_schedule",
            months,
            cuotaMinor,
            startMonth,
          },
          idToken,
        );
      }
      return ledgerApi.updateEventMsi(event.id, { action: "set_msi", months, cuotaMinor }, idToken);
    },
    onSuccess: updateCache,
  });

  const cancelMsiMutation = useMutation({
    mutationFn: () =>
      demoMode
        ? Promise.resolve({
            ...event,
            msi: event.msi
              ? {
                  ...event.msi,
                  status: "cancelled" as const,
                  installments: event.msi.installments.map((item) =>
                    item.status === "committed" ? { ...item, status: "cancelled" as const } : item,
                  ),
                }
              : undefined,
          })
        : ledgerApi.updateEventMsi(event.id, { action: "cancel_msi_remaining" }, idToken),
    onSuccess: updateCache,
  });

  const categoryMutation = useMutation({
    mutationFn: async () => {
      const next = categoryId.trim() ? categoryId.trim() : null;
      if (demoMode) return { ...event, categoryId: next };
      return ledgerApi.setEventCategory(event.id, { categoryId: next, updateRule: true }, idToken);
    },
    onSuccess: (updated) => {
      updateCache(updated);
      setCategoryId(updated.categoryId ?? "");
    },
    onError: (err) => setError(err instanceof Error ? err.message : "No se pudo guardar la categoría."),
  });

  const personalAmountMutation = useMutation({
    mutationFn: async () => {
      if (!personalAmount.trim()) {
        throw new Error("Indica un monto válido para Mi parte.");
      }
      const personalAmountMinor = Math.round(Number(personalAmount) * 100);
      if (!Number.isFinite(Number(personalAmount)) || !Number.isSafeInteger(personalAmountMinor)) {
        throw new Error("Indica un monto válido para Mi parte.");
      }
      if (personalAmountMinor < 0 || personalAmountMinor > event.amount.amountMinor) {
        throw new Error("Mi parte debe estar entre $0 y el total pagado.");
      }
      if (demoMode) return { ...event, personalAmountMinor };
      return ledgerApi.setEventPersonalAmount(event.id, personalAmountMinor, idToken);
    },
    onSuccess: (updated) => {
      updateCache(updated);
      setPersonalAmount(
        ((updated.personalAmountMinor ?? updated.amount.amountMinor) / 100).toFixed(2),
      );
    },
    onError: (err) => setError(err instanceof Error ? err.message : "No se pudo guardar Mi parte."),
  });

  const clearPersonalAmountMutation = useMutation({
    mutationFn: () =>
      demoMode
        ? Promise.resolve({ ...event, personalAmountMinor: undefined })
        : ledgerApi.clearEventPersonalAmount(event.id, idToken),
    onSuccess: (updated) => {
      updateCache(updated);
      setPersonalAmount("");
    },
    onError: (err) => setError(err instanceof Error ? err.message : "No se pudo usar el total pagado."),
  });

  const toggleRaw = async () => {
    if (rawEmail) {
      setRawEmail(undefined);
      return;
    }
    try {
      setRawEmail(demoMode ? event.rawEmail : await ledgerApi.rawEmail(event.id, idToken));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo leer la fuente.");
    }
  };

  const verify = async () => {
    try {
      await verifyMutation.mutateAsync();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo actualizar el movimiento.");
    }
  };

  const reject = async () => {
    try {
      await rejectMutation.mutateAsync();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo rechazar el movimiento.");
    }
  };

  const saveMsi = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    try {
      await msiMutation.mutateAsync();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el MSI.");
    }
  };

  const isApplePayCapture = event.source.kind === "apple_pay_shortcut";
  const isManualCapture = event.source.kind === "manual_entry" || event.captureSource === "manual";
  const isCsvCapture = !isApplePayCapture && !isManualCapture && event.source.contentType === "text/csv";
  const isAmexStatement = event.captureSource === "amex_statement";
  const isSantanderStatement = event.captureSource === "santander_statement";
  const hasRawSource =
    isManualCapture
    || isCsvCapture
    || isAmexStatement
    || isSantanderStatement
    || !isApplePayCapture
    || event.hasRawEmail === true;
  const sources = event.captureSources ?? (event.captureSource ? [event.captureSource] : []);
  const hasLinkedEmail = sources.includes("email") || event.hasRawEmail === true;
  const evidenceTitle = isManualCapture
    ? hasLinkedEmail
      ? "Registro manual · también correo"
      : "Registro manual"
    : isApplePayCapture
      ? "Captura de Apple Pay"
      : isCsvCapture
        ? "CSV de Santander"
        : isAmexStatement
          ? "Estado de cuenta Amex"
          : isSantanderStatement
            ? "Estado de cuenta Santander"
            : "Correo original";
  const evidenceSummary = isManualCapture
    ? "Alta manual conservada"
    : isApplePayCapture
      ? "Observación automática conservada"
      : isCsvCapture
        ? "CSV original conservado"
        : isAmexStatement || isSantanderStatement
          ? "Estado de cuenta conservado"
          : "Mensaje original conservado";
  const evidenceDetail = isApplePayCapture
    ? event.source.cardRaw
    : "key" in event.source
      ? event.source.key
      : event.id;

  return (
    <Sheet eyebrow="MOVIMIENTO OBSERVADO" title={event.merchantRaw} onClose={onClose}>
      <div className="event-detail">
        <div className="detail-amount">
          <strong>
            <Amt>
              {event.personalAmountMinor === undefined
                ? eventMoney(event)
                : money(event.personalAmountMinor)}
            </Amt>
          </strong>
          <span className={`status ${event.status}`}>
            {event.personalAmountMinor === undefined
              ? statusLabel[event.status]
              : "Compartido"}
          </span>
        </div>
        <p className="detail-subtitle">
          {event.personalAmountMinor === undefined ? "" : `De ${eventMoney(event)} pagados · `}
          {institutionLabel(event.institution)} · {event.accountName}
          {event.msi ? ` · MSI ${event.msi.months}` : ""}
        </p>
        {event.parseWarnings.length > 0 && (
          <div className="warning">
            <span>!</span>
            <div>
              <strong>Necesita confirmación</strong>
              <p>{event.parseWarnings[0]}</p>
            </div>
            <button onClick={verify}>Confirmar</button>
          </div>
        )}
        {event.status === "pending_foreign" && (
          <div className="warning foreign-pending">
            <span>!</span>
            <div>
              <strong>Aún no suma en Has gastado</strong>
              <p>
                Esta es la autorización en USD. Cuando llegue el correo Santander, Olbia usará el cargo
                posteado en MXN y conservará ambas evidencias.
              </p>
            </div>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <dl className="facts">
          <div>
            <dt>Fecha de compra</dt>
            <dd>{longDateFormatter.format(eventDate(event))}</dd>
          </div>
          <div>
            <dt>Procesado</dt>
            <dd>{longDateFormatter.format(new Date(event.ingestedAt))}</dd>
          </div>
          <div>
            <dt>Parser</dt>
            <dd>{event.parserVersion}</dd>
          </div>
          <div>
            <dt>Estado</dt>
            <dd>{statusLabel[event.status]}</dd>
          </div>
        </dl>

        {!event.msi
          && event.status !== "rejected"
          && event.status !== "deferred_msi"
          && event.status !== "pending_foreign" && (
          <form
            className="sheet-form"
            onSubmit={(formEvent) => {
              formEvent.preventDefault();
              personalAmountMutation.mutate();
            }}
          >
            <div className="detail-section-heading">
              <div>
                <p className="eyebrow">GASTO COMPARTIDO</p>
                <h3>Mi parte</h3>
              </div>
            </div>
            <p className="detail-subtitle">
              Resumen usa este monto. El estado de cuenta conserva el total pagado de {eventMoney(event)}.
            </p>
            <Field label="Mi parte">
              <div className="money-input">
                <span>$</span>
                <input
                  inputMode="decimal"
                  type="number"
                  min="0"
                  max={(event.amount.amountMinor / 100).toFixed(2)}
                  step="0.01"
                  placeholder={(event.amount.amountMinor / 100).toFixed(2)}
                  value={personalAmount}
                  onChange={(change) => setPersonalAmount(change.target.value)}
                />
              </div>
            </Field>
            <button className="primary-button" type="submit" disabled={personalAmountMutation.isPending}>
              {personalAmountMutation.isPending ? "Guardando…" : "Guardar Mi parte"}
            </button>
            {event.personalAmountMinor !== undefined && (
              <button
                className="secondary-button"
                type="button"
                disabled={clearPersonalAmountMutation.isPending}
                onClick={() => clearPersonalAmountMutation.mutate()}
              >
                {clearPersonalAmountMutation.isPending ? "Guardando…" : "Usar el total pagado"}
              </button>
            )}
          </form>
        )}

        <form
          className="sheet-form"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            categoryMutation.mutate();
          }}
        >
          <div className="detail-section-heading">
            <div>
              <p className="eyebrow">CATEGORÍA</p>
              <h3>Clasificación del gasto</h3>
            </div>
          </div>
          <Field label="Categoría">
            <select value={categoryId} onChange={(change) => setCategoryId(change.target.value)}>
              <option value="">Sin categoría</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>
          <button className="primary-button" type="submit" disabled={categoryMutation.isPending}>
            {categoryMutation.isPending ? "Guardando…" : "Guardar categoría"}
          </button>
        </form>

        {event.status !== "pending_foreign" && (
        <form className="sheet-form" onSubmit={(formEvent) => void saveMsi(formEvent)}>
          <div className="detail-section-heading">
            <div>
              <p className="eyebrow">MESES SIN INTERESES</p>
              <h3>{event.msi?.needsScheduleCompletion ? "Completar plan MSI" : "Plan MSI"}</h3>
            </div>
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              disabled={event.personalAmountMinor !== undefined}
              checked={msiEnabled}
              onChange={(change) => {
                setMsiEnabled(change.target.checked);
                if (change.target.checked) {
                  const months = Number(msiMonths) || 3;
                  setMsiCuota((defaultCuotaMinor(event.amount.amountMinor, months) / 100).toFixed(2));
                }
              }}
            />
            <span>Esta compra va a MSI</span>
          </label>
          {event.personalAmountMinor !== undefined && (
            <p className="detail-subtitle">Usa el total pagado antes de configurar MSI.</p>
          )}
          {msiEnabled && (
            <>
              <Field label="Meses">
                <input
                  inputMode="numeric"
                  value={msiMonths}
                  onChange={(change) => {
                    const value = change.target.value;
                    setMsiMonths(value);
                    const months = Number(value);
                    if (Number.isInteger(months) && months > 0) {
                      setMsiCuota((defaultCuotaMinor(event.amount.amountMinor, months) / 100).toFixed(2));
                    }
                  }}
                />
              </Field>
              <Field label="Cuota mensual">
                <div className="money-input">
                  <span>$</span>
                  <input
                    inputMode="decimal"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={msiCuota}
                    onChange={(change) => setMsiCuota(change.target.value)}
                  />
                </div>
              </Field>
              {event.msi && (
                <p className="detail-subtitle">
                  {event.msi.installments.filter((item) => item.status === "spent").length} gastadas ·{" "}
                  {event.msi.installments.filter((item) => item.status === "committed").length}{" "}
                  comprometidas
                  {event.msi.origin === "amex_auto" ? " · Amex auto" : ""}
                </p>
              )}
            </>
          )}
          <button className="primary-button" type="submit" disabled={msiMutation.isPending}>
            {msiMutation.isPending ? "Guardando…" : "Guardar MSI"}
          </button>
          {event.msi && (
            <button
              className="secondary-button"
              type="button"
              disabled={cancelMsiMutation.isPending}
              onClick={() =>
                void cancelMsiMutation.mutateAsync().catch((reason) => {
                  setError(reason instanceof Error ? reason.message : "No se pudo cancelar el MSI.");
                })
              }
            >
              Cancelar cuotas restantes
            </button>
          )}
        </form>
        )}

        <div className="detail-section-heading">
          <div>
            <p className="eyebrow">EVIDENCIA</p>
            <h3>{evidenceTitle}</h3>
          </div>
          {hasRawSource && (
            <button className="secondary-button" onClick={toggleRaw}>
              {rawEmail ? "Ocultar" : isApplePayCapture ? "Ver correo" : "Ver fuente"}
            </button>
          )}
        </div>
        {rawEmail ? (
          <pre className="raw-source">{rawEmail}</pre>
        ) : (
          <div className="source-summary">
            <Mark />
            <div>
              <strong>{evidenceSummary}</strong>
              <p>{evidenceDetail}</p>
            </div>
          </div>
        )}
        {event.msi && (
          <div className="payment-list">
            {event.msi.installments.map((installment) => (
              <div key={installment.index} className="payment-row" style={{ cursor: "default" }}>
                <span className="date-block">
                  <small>{installment.month.slice(5)}</small>
                  <strong>{String(installment.index).padStart(2, "0")}</strong>
                </span>
                <span className="payment-name">
                  <strong>
                    MSI {installment.index}/{event.msi?.months}
                  </strong>
                  <small>{installment.status}</small>
                </span>
                <strong className="payment-amount">
                  <Amt>{money(installment.amountMinor)}</Amt>
                </strong>
              </div>
            ))}
          </div>
        )}
        {event.status !== "rejected" && event.status !== "deferred_msi" && (
          <button
            className="delete-button"
            type="button"
            disabled={rejectMutation.isPending}
            onClick={() => void reject()}
          >
            {rejectMutation.isPending ? "Rechazando…" : "No cuenta en el mes"}
          </button>
        )}
        {event.status === "deferred_msi" && (
          <p className="detail-subtitle">
            Diferida a MSI automático Amex. No suma en Has gastado; la cuota vive en el plan
            MESES EN AUTOMÁTICO.
          </p>
        )}
        {event.status === "pending_foreign" && (
          <p className="detail-subtitle">
            La autorización seguirá visible aquí. Si no llega el cargo Santander, puedes marcarla como
            “No cuenta en el mes” sin borrar su evidencia.
          </p>
        )}
      </div>
    </Sheet>
  );
}
