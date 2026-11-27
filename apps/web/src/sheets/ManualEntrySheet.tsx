import { dayKeyInZone, INSTITUTIONS, type Institution, type MsiInstallment } from "@finance/domain";
import { FormEvent, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ledgerApi } from "../api/client";
import { Amt } from "../components/Amt";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";
import { eventDate, institutionLabel, money } from "../lib/format";
import { monthlyPlanQueryKey } from "../lib/query-keys";
import type { ManualReconciliationInput, ManualReconciliationPreview, PurchaseEvent } from "../types";

export const movementLabels = {
  card_purchase: "Cobro",
  outgoing_transfer: "Transferencia saliente",
  card_charge: "Cargo recurrente",
} as const;

export const evidenceLabels = {
  confirmation: "Confirmación manual",
  screenshot: "Captura de pantalla",
  bank_app: "Aplicación bancaria",
  receipt: "Recibo",
} as const;

interface ManualEntryProps {
  idToken: string;
  demoMode: boolean;
  now: Date;
  onCreated(event: PurchaseEvent): void;
  onCredit?(): void;
  target?: PurchaseEvent;
  installment?: MsiInstallment;
}

export function ManualEntrySheet({ onClose, ...props }: ManualEntryProps & { onClose(): void }) {
  const title = props.installment ? `Confirmar cuota ${props.installment.index}/${props.target?.msi?.months}`
    : props.target ? "Vincular evidencia" : "Registrar movimiento";
  return <Sheet eyebrow="CONCILIACIÓN" title={title} onClose={onClose}><ManualEntryForm {...props} /></Sheet>;
}

const attachmentData = (file: File): Promise<string> => new Promise((resolve, reject) => {
  if (file.size > 1_048_576) return reject(new Error("El adjunto admite hasta 1 MB."));
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("No se pudo leer el adjunto."));
  reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
  reader.readAsDataURL(file);
});

function ManualEntryForm({ idToken, demoMode, now, onCreated, onCredit, target, installment }: ManualEntryProps) {
  const [institution, setInstitution] = useState<Institution>(target?.institution ?? "american_express_mx");
  const [movementType, setMovementType] = useState<ManualReconciliationInput["movementType"]>(
    target?.eventType ?? "card_purchase");
  const [creditType, setCreditType] = useState<"income" | "refund" | "card_payment">();
  const [refundAccount, setRefundAccount] = useState<"cash" | "credit_card">("credit_card");
  const [confirmedPosted, setConfirmedPosted] = useState(false);
  const [creditReview, setCreditReview] = useState<{ operationId: string; amountMinor: number }>();
  const [merchantRaw, setMerchantRaw] = useState(target?.merchantRaw ?? "");
  const [amount, setAmount] = useState(target ? ((installment?.amountMinor ?? target.amount.amountMinor) / 100).toFixed(2) : "");
  const today = dayKeyInZone(now);
  const [occurredOn, setOccurredOn] = useState(installment
    ? (today.startsWith(installment.month) ? today : "")
    : target ? dayKeyInZone(eventDate(target)) : today);
  const [accountLastFour, setAccountLastFour] = useState(target?.accountLastFour ?? "");
  const [evidenceKind, setEvidenceKind] = useState<ManualReconciliationInput["evidenceKind"]>("confirmation");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [file, setFile] = useState<File>();
  const [paymentId, setPaymentId] = useState("");
  const [createPlan, setCreatePlan] = useState(false);
  const [months, setMonths] = useState("");
  const [principal, setPrincipal] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [review, setReview] = useState<{ input: ManualReconciliationInput; preview: ManualReconciliationPreview }>();
  const month = occurredOn.slice(0, 7);
  const canLinkFixed = !demoMode && !createPlan && !installment && !creditType;
  const plan = useQuery({ queryKey: monthlyPlanQueryKey(month), queryFn: () => ledgerApi.monthlyPlan(month, idToken),
    enabled: canLinkFixed && /^\d{4}-\d{2}$/.test(month) });
  const payments = plan.data?.upcomingPayments.filter(payment => !payment.reconciliation) ?? [];

  const prepare = async (input: ManualReconciliationInput) => {
    setSaving(true);
    setError(undefined);
    try {
      const preview = await ledgerApi.previewManualReconciliation(input, idToken);
      setReview({ input, preview });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo revisar la evidencia.");
    } finally {
      setSaving(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    const amountMinor = Math.round(Number(amount) * 100);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return;
    if (demoMode) {
      const createdAt = now.toISOString();
      onCreated({
        id: `manual-${crypto.randomUUID()}`, institution, eventType: movementType, status: "accepted",
        accountName: institutionLabel(institution), amount: { amountMinor, currency: "MXN" }, merchantRaw: merchantRaw.trim(),
        occurredAt: `${occurredOn}T12:00:00.000Z`, receivedAt: createdAt, ingestedAt: createdAt,
        parserVersion: "manual-entry-v1", source: { kind: "manual_entry", bucket: "demo", key: "demo", sha256: "demo", contentType: "application/json" },
        captureSource: "manual", captureSources: ["manual"], parseWarnings: [], revisions: [],
      });
      return;
    }
    setSaving(true);
    try {
      if (creditType) {
        const accountKind = creditType === "income" ? "cash" : creditType === "card_payment" ? "credit_card" : refundAccount;
        const reviewed = await ledgerApi.previewManualCredit({ creditType, institution, accountLastFour, accountKind,
          amountMinor, postedOn: occurredOn, description: merchantRaw.trim(), evidenceReference: evidenceReference.trim(),
          confirmedPosted, ...(creditType === "income" ? { incomeType: "otro" } : {}) }, idToken);
        setCreditReview({ ...reviewed, amountMinor });
        return;
      }
      const payment = payments.find(item => item.id === paymentId);
      const attachmentBase64 = file && await attachmentData(file);
      await prepare({
        institution, movementType, action: installment ? "installment" : target ? "link" : "create",
        movementId: target?.id, installmentIndex: installment?.index, merchantRaw: merchantRaw.trim(),
        amountMinor, occurredOn, evidenceKind, evidenceReference: evidenceReference.trim() || undefined,
        accountLastFour: accountLastFour || undefined, attachmentBase64,
        ...(createPlan ? { newPlan: { months: Number(months), principalMinor: Math.round(Number(principal) * 100) } } : {}),
        ...(payment ? { fixedPayment: { paymentId: payment.id,
          expectedPayment: { name: payment.name, amountMinor: payment.amountMinor, dueDay: payment.dueDay } } } : {}),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo leer la evidencia.");
    } finally {
      setSaving(false);
    }
  };

  const apply = async () => {
    if (!review?.preview.canApply) return;
    setSaving(true);
    setError(undefined);
    try {
      onCreated(await ledgerApi.applyManualReconciliation(review.preview.operationId, idToken));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar la conciliación.");
    } finally {
      setSaving(false);
    }
  };

  if (creditReview) return <div className="sheet-form">
    <p>{merchantRaw} · {occurredOn} · <Amt>{money(creditReview.amountMinor)}</Amt></p>
    <p>{institutionLabel(institution)} · {accountLastFour} · {evidenceReference}</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    <button className="primary-button" type="button" disabled={saving} onClick={async () => {
      setSaving(true); setError(undefined);
      try { await ledgerApi.applyManualCredit(creditReview.operationId, idToken); onCredit?.(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo registrar el abono."); }
      finally { setSaving(false); }
    }}>Confirmar abono</button>
    <button className="secondary-button" type="button" disabled={saving} onClick={() => setCreditReview(undefined)}>Volver a editar</button>
  </div>;

  if (review) return <div className="sheet-form">
    <p>{movementLabels[review.input.movementType]} · {review.input.merchantRaw} · {review.input.occurredOn}</p>
    <p><Amt>{money(review.input.amountMinor)}</Amt> · {evidenceLabels[review.input.evidenceKind]}</p>
    {review.input.newPlan && <p>Cuota 1/{review.input.newPlan.months} · Compra total <Amt>{money(review.input.newPlan.principalMinor)}</Amt></p>}
    {review.preview.expectedAmountMinor !== undefined && review.preview.expectedAmountMinor !== review.input.amountMinor
      && <p>Importe programado <Amt>{money(review.preview.expectedAmountMinor)}</Amt></p>}
    {review.preview.fixedPayment && <p>Vincula {review.preview.fixedPayment.name} · Programado <Amt>{money(review.preview.fixedPayment.amountMinor)}</Amt></p>}
    {review.preview.candidates.length > 0 && <div className="sheet-form">
      <p>Encontramos movimientos del mismo día y concepto.</p>
      {review.preview.candidates.map(candidate => review.input.newPlan ? <p key={candidate.id}>
        {candidate.merchantRaw} · <Amt>{money(candidate.amount.amountMinor)}</Amt>
      </p> : <button className="secondary-button" type="button" key={candidate.id}
        disabled={saving || candidate.status === "rejected" || candidate.amount.amountMinor !== review.input.amountMinor}
        onClick={() => void prepare({ ...review.input, action: "link", movementType: candidate.movementType, movementId: candidate.id, distinct: false })}>
        Vincular {candidate.merchantRaw} · <Amt>{money(candidate.amount.amountMinor)}</Amt>
        {candidate.accountLastFour ? ` · ${candidate.accountLastFour}` : ""}
      </button>)}
      {!review.input.distinct && <button className="secondary-button" type="button" disabled={saving}
        onClick={() => void prepare({ ...review.input, distinct: true })}>Es un movimiento distinto</button>}
    </div>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {review.preview.canApply && <button className="primary-button" type="button" disabled={saving} onClick={() => void apply()}>
      {saving ? "Guardando…" : "Confirmar conciliación"}
    </button>}
    <button className="secondary-button" type="button" disabled={saving} onClick={() => { setReview(undefined); setError(undefined); }}>Volver a editar</button>
  </div>;

  return <form className="sheet-form" onSubmit={submit}>
    {!target && <Field label="Tipo de movimiento">
      <select value={creditType ?? movementType} onChange={event => {
        const value = event.target.value;
        if (value === "income" || value === "refund" || value === "card_payment") setCreditType(value);
        else { setCreditType(undefined); setMovementType(value as typeof movementType); }
        setPaymentId(""); setCreatePlan(false);
      }}>
        {Object.entries(movementLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        {!demoMode && onCredit && <>
          <option value="income">Depósito de ingreso</option>
          <option value="refund">Devolución</option>
          <option value="card_payment">Pago de tarjeta</option>
        </>}
      </select>
    </Field>}
    <Field label="Institución">
      <select value={institution} disabled={Boolean(target)} onChange={event => setInstitution(event.target.value as Institution)}>
        {INSTITUTIONS.map(value => <option key={value} value={value}>{institutionLabel(value)}</option>)}
      </select>
    </Field>
    <Field label="Concepto">
      <input value={merchantRaw} onChange={event => setMerchantRaw(event.target.value)} maxLength={200} required />
    </Field>
    <Field label={createPlan ? "Primera cuota MXN" : "Importe MXN"}>
      <input inputMode="decimal" type="number" min="0.01" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} required />
    </Field>
    <Field label="Fecha observada">
      <input type="date" value={occurredOn} onChange={event => { setOccurredOn(event.target.value); setPaymentId(""); }} required />
    </Field>
    <Field label={createPlan || creditType ? "Últimos cuatro de la cuenta o tarjeta" : "Últimos cuatro de la cuenta (opcional)"}>
      <input inputMode="numeric" value={accountLastFour} pattern="[0-9]{4}" maxLength={4} required={createPlan || Boolean(creditType)}
        onChange={event => setAccountLastFour(event.target.value.replace(/\D/g, "").slice(0, 4))} />
    </Field>
    {creditType ? <>
      {creditType === "refund" && <Field label="Cuenta acreditada">
        <select value={refundAccount} onChange={event => setRefundAccount(event.target.value as typeof refundAccount)}>
          <option value="credit_card">Tarjeta de crédito</option><option value="cash">Cuenta de efectivo</option>
        </select>
      </Field>}
      <Field label="Referencia bancaria">
        <input value={evidenceReference} onChange={event => setEvidenceReference(event.target.value)} minLength={4} maxLength={160} required />
      </Field>
      <label className="checkbox-row"><input type="checkbox" checked={confirmedPosted}
        onChange={event => setConfirmedPosted(event.target.checked)} required />El banco ya acreditó el abono</label>
    </> : <>
    <Field label="Fuente">
      <select value={evidenceKind} onChange={event => setEvidenceKind(event.target.value as typeof evidenceKind)}>
        {Object.entries(evidenceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </Field>
    <Field label="Referencia o nota (opcional)">
      <input value={evidenceReference} onChange={event => setEvidenceReference(event.target.value)} maxLength={300} />
    </Field>
    </>}
    {!demoMode && !target && !creditType && movementType === "card_purchase" && <>
      <label className="checkbox-row"><input type="checkbox" checked={createPlan}
        onChange={event => { setCreatePlan(event.target.checked); setPaymentId(""); }} />
        Primera cuota de un plan nuevo
      </label>
      {createPlan && <>
        <Field label="Número de cuotas"><input type="number" inputMode="numeric" min="1" max="48" value={months}
          onChange={event => setMonths(event.target.value)} required /></Field>
        <Field label="Importe total de la compra MXN"><input type="number" inputMode="decimal" min="0.01" step="0.01"
          value={principal} onChange={event => setPrincipal(event.target.value)} required /></Field>
      </>}
    </>}
    {!demoMode && !creditType && <Field label="Adjuntar PNG, JPEG o PDF (opcional, hasta 1 MB)">
      <input key={file ? "attached" : "empty"} type="file" accept="image/png,image/jpeg,application/pdf" onChange={event => setFile(event.target.files?.[0])} />
    </Field>}
    {!creditType && file && <div className="sheet-form"><p>{file.name}</p>
      <button className="secondary-button" type="button" onClick={() => setFile(undefined)}>Quitar adjunto</button></div>}
    {canLinkFixed && payments.length > 0 && <Field label="Gasto fijo del mes (opcional)">
      <select value={paymentId} onChange={event => setPaymentId(event.target.value)}>
        <option value="">Sin gasto fijo</option>
        {payments.map(payment => <option key={payment.id} value={payment.id}>{payment.name}</option>)}
      </select>
    </Field>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <button className="primary-button" type="submit" disabled={saving}>{saving ? "Revisando…" : "Revisar evidencia"}</button>
  </form>;
}
