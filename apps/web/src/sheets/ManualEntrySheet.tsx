import { INSTITUTIONS, type Institution } from "@finance/domain";
import { FormEvent, useState } from "react";
import { ledgerApi } from "../api/client";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";
import { institutionLabel, monthKey, timeZone } from "../lib/format";
import type { PurchaseEvent } from "../types";

const todayInZone = (now: Date): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(now);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export function ManualEntrySheet({
  idToken,
  demoMode,
  now,
  onClose,
  onCreated,
}: {
  idToken: string;
  demoMode: boolean;
  now: Date;
  onClose(): void;
  onCreated(event: PurchaseEvent): void;
}) {
  const [institution, setInstitution] = useState<Institution>("american_express_mx");
  const [merchantRaw, setMerchantRaw] = useState("");
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayInZone(now));
  const [accountLastFour, setAccountLastFour] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(amount);
    if (!merchantRaw.trim() || !Number.isFinite(parsed) || parsed <= 0) return;
    if (accountLastFour && !/^\d{4}$/.test(accountLastFour)) {
      setError("Los últimos cuatro deben ser exactamente 4 dígitos.");
      return;
    }
    setSaving(true);
    setError(undefined);
    const amountMinor = Math.round(parsed * 100);
    try {
      if (demoMode) {
        const createdAt = now.toISOString();
        onCreated({
          id: `manual-${crypto.randomUUID()}`,
          institution,
          eventType: "card_purchase",
          status: "accepted",
          accountName: accountLastFour
            ? `${institutionLabel(institution)} terminada en ${accountLastFour}`
            : `${institutionLabel(institution)} (registro manual)`,
          amount: { amountMinor, currency: "MXN" },
          merchantRaw: merchantRaw.trim(),
          occurredAt: `${occurredOn}T12:00:00.000Z`,
          receivedAt: createdAt,
          ingestedAt: createdAt,
          parserVersion: "manual-entry-v1",
          source: {
            kind: "manual_entry",
            bucket: "finance-raw-source-demo",
            key: `manual-entries/demo/${occurredOn}.json`,
            sha256: "demo-manual-entry",
            contentType: "application/json",
          },
          captureSource: "manual",
          captureSources: ["manual"],
          parseWarnings: [],
          rawEmail: JSON.stringify(
            {
              kind: "manual_entry",
              institution,
              merchantRaw: merchantRaw.trim(),
              amountMinor,
              occurredOn,
              accountLastFour: accountLastFour || undefined,
              note: note.trim() || undefined,
            },
            null,
            2,
          ),
          revisions: [],
        });
        return;
      }
      const created = await ledgerApi.createManualEvent(
        {
          institution,
          merchantRaw: merchantRaw.trim(),
          amountMinor,
          occurredOn,
          accountLastFour: accountLastFour || undefined,
          note: note.trim() || undefined,
        },
        idToken,
      );
      onCreated(created);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo registrar el cobro.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet eyebrow="FUERA DE AUTOMATISMO" title="Registrar cobro" onClose={onClose}>
      <form className="sheet-form" onSubmit={submit}>
        <p>Úsalo cuando el cobro no llegó por correo ni por CSV. Suma al gasto de {monthKey(now)}.</p>
        <Field label="Institución">
          <select
            value={institution}
            onChange={(event) => setInstitution(event.target.value as Institution)}
            required
          >
            {INSTITUTIONS.map((value) => (
              <option key={value} value={value}>
                {institutionLabel(value)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Comercio">
          <input
            autoFocus
            value={merchantRaw}
            onChange={(event) => setMerchantRaw(event.target.value)}
            placeholder="Ej. Amazon MX"
            maxLength={200}
            required
          />
        </Field>
        <Field label="Cantidad">
          <div className="money-input">
            <span>$</span>
            <input
              inputMode="decimal"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              required
            />
          </div>
        </Field>
        <Field label="Fecha del cobro">
          <input
            type="date"
            value={occurredOn}
            onChange={(event) => setOccurredOn(event.target.value)}
            required
          />
        </Field>
        <Field label="Tarjeta (opcional)">
          <input
            inputMode="numeric"
            value={accountLastFour}
            onChange={(event) => setAccountLastFour(event.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="Últimos 4"
            maxLength={4}
          />
        </Field>
        <Field label="Nota (opcional)">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Ej. No llegó el correo de Amex"
            maxLength={500}
          />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Guardando…" : "Sumar al mes"}
        </button>
      </form>
    </Sheet>
  );
}
