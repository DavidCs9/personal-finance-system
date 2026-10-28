import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildMsiSchedule } from "@finance/domain";
import { mockEvents } from "../api/mock-data";
import type { PlannedPayment } from "../monthly-plan";
import { eligibleReconciliationEvents, PaymentReconciliation, PaymentReconciliationConfirmation, type ObservedEvent } from "./PaymentReconciliation";

const month = "2026-10";
const payment: PlannedPayment = { id: "openai", name: "OpenAI", amountMinor: 399_00, dueDay: 18 };
const observed = (overrides: Partial<ObservedEvent> = {}): ObservedEvent => ({
  ...mockEvents[0]!, id: "charge", status: "accepted", merchantRaw: "OPENAI *CHATGPT SUBSCR",
  occurredAt: "2026-10-18T12:00:00.000Z", amount: { currency: "MXN", amountMinor: 399_03 },
  personalAmountMinor: undefined, msi: undefined, ...overrides,
});

describe("explicit payment reconciliation", () => {
  it("keeps repeated signatures as independent choices and accepts Mi parte zero", () => {
    const first = observed({ id: "first", personalAmountMinor: 0 });
    const second = observed({ id: "second", status: "needs_review" });
    expect(eligibleReconciliationEvents([first, second], month)).toEqual([first, second]);
    const html = renderToStaticMarkup(<PaymentReconciliation payment={payment} month={month}
      candidates={[first, second]} candidatesLoading={false} onReconcile={async () => {}} />);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain('value="first"');
    expect(html).toContain('value="second"');
    expect(html).toContain('<span class="amt">$0.00</span>');
    expect(html).toContain('Por confirmar');
  });

  it("excludes rejected, foreign, deferred, MSI, other-month and malformed candidates", () => {
    const invalid = [
      observed({ id: "", status: "accepted" }), observed({ status: "rejected" }),
      observed({ status: "pending_foreign" }), observed({ status: "deferred_msi" }),
      observed({ amount: { currency: "USD", amountMinor: 399_00 } }),
      observed({ msi: buildMsiSchedule({ principalMinor: 399_00, months: 3, startMonth: month, origin: "manual" }) }),
      observed({ occurredAt: "2026-09-30T12:00:00Z" }), observed({ occurredAt: "bad-date" }),
      observed({ amount: { currency: "MXN", amountMinor: 0 } }),
      observed({ amount: { currency: "MXN", amountMinor: -1 } }),
      observed({ amount: { currency: "MXN", amountMinor: 399.5 } }),
      observed({ personalAmountMinor: -1 }), observed({ personalAmountMinor: 400_00 }),
    ];
    expect(eligibleReconciliationEvents(invalid, month)).toEqual([]);
    // Month membership is Chihuahua calendar time, including UTC month boundaries.
    expect(eligibleReconciliationEvents([observed({ occurredAt: "2026-11-01T04:00:00Z" })], month)).toHaveLength(1);
  });

  it("does not auto-select or mutate even when the only candidate exactly matches the fixed payment", () => {
    const onReconcile = vi.fn();
    const html = renderToStaticMarkup(<PaymentReconciliation payment={payment} month={month}
      candidates={[observed({ amount: { currency: "MXN", amountMinor: 399_00 } })]}
      candidatesLoading={false} onReconcile={onReconcile} />);
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain('aria-label="Confirmar vínculo"');
    expect(html).toContain('class="secondary-button" disabled=""');
    expect(onReconcile).not.toHaveBeenCalled();
  });

  it("uses reception as the financial date when purchase date is absent, even after next-month reprocessing", () => {
    const reprocessed = observed({ occurredAt: undefined, receivedAt: "2026-09-30T18:00:00.000Z",
      ingestedAt: "2026-10-01T18:00:00.000Z" });
    expect(eligibleReconciliationEvents([reprocessed], "2026-09")).toEqual([reprocessed]);
    expect(eligibleReconciliationEvents([reprocessed], "2026-10")).toEqual([]);
    const dateLabel = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Chihuahua" })
      .format(new Date(reprocessed.receivedAt));
    const picker = renderToStaticMarkup(<PaymentReconciliation payment={payment} month="2026-09"
      candidates={[reprocessed]} candidatesLoading={false} onReconcile={async () => {}} />);
    expect(picker).toContain(dateLabel);
    const confirmation = renderToStaticMarkup(<PaymentReconciliationConfirmation payment={payment} month="2026-09"
      event={reprocessed} busy={false} onConfirm={() => {}} onCancel={() => {}} />);
    expect(confirmation).toContain(dateLabel);
  });

  it("confirms the explicit ID against the whole fixed payment, with gross and personal amounts separate", () => {
    const onConfirm = vi.fn();
    const event = observed({ id: "chosen", personalAmountMinor: 0, status: "needs_review" });
    const view = PaymentReconciliationConfirmation({ payment, month, event, busy: false, onConfirm, onCancel() {} });
    const html = renderToStaticMarkup(view);
    expect(html).toContain('programado <span class="amt">$399.00</span>');
    expect(html).toContain('Mi parte: <span class="amt">$0.00</span>');
    expect(html).toContain('bruto bancario: <span class="amt">$399.03</span>');
    expect(html).toContain('todo el fijo de este mes');
    expect(html).toContain('Los importes son distintos');
    expect(html).toContain('El cobro sigue por confirmar');
    primaryButton(view).props.onClick?.();
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("chosen");
  });

  it("requires explicit unlink confirmation and blocks confirmation while busy or disabled", () => {
    const onConfirm = vi.fn();
    const unlink = PaymentReconciliationConfirmation({ payment, month, unlink: true, busy: false, onConfirm, onCancel() {} });
    expect(renderToStaticMarkup(unlink)).toContain('El cobro se conserva');
    primaryButton(unlink).props.onClick?.();
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(null);
    for (const state of [{ busy: true }, { busy: false, disabled: true }]) {
      const blocked = PaymentReconciliationConfirmation({ payment, month, event: observed(), ...state, onConfirm, onCancel() {} });
      expect(primaryButton(blocked).props.disabled).toBe(true);
      primaryButton(blocked).props.onClick?.();
    }
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("distinguishes current valid and invalid links and never preselects a replacement", () => {
    for (const valid of [true, false]) {
      const linked = { ...payment, reconciliation: { eventId: "linked", merchantRaw: "Cobro original", amountMinor: 0,
        grossAmountMinor: 399_03, occurredAt: "2026-10-18T12:00:00Z", valid, invalidReason: "El movimiento fue rechazado o ya no cuenta como gasto." } };
      const html = renderToStaticMarkup(<PaymentReconciliation payment={linked} month={month}
        candidates={[observed({ id: "other" })]} candidatesLoading={false} onReconcile={async () => {}} />);
      expect(html).toContain(valid ? "Cobro vinculado" : "Revisar vínculo");
      expect(html).toContain("Cobro original");
      expect(html).toContain('<span class="amt">$0.00</span>');
      expect(html).toContain("Revisar desvínculo");
      expect(html).not.toContain('type="radio"');
      if (!valid) {
        expect(html).toContain("no descuenta el fijo por conciliar");
        expect(html).toContain("El movimiento fue rechazado o ya no cuenta como gasto.");
      }
    }
  });

  it("keeps query failures recoverable and loading separate from an empty candidate list", () => {
    const props = { payment, month, candidates: [observed()], onReconcile: async () => {}, onRetryCandidates() {} };
    const failed = renderToStaticMarkup(<PaymentReconciliation {...props} candidatesLoading={false} candidatesError="No pudimos leer los cobros." />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Reintentar cobros');
    expect(failed).not.toContain('type="radio"');
    expect(failed).not.toContain('No hay cobros elegibles');
    const loading = renderToStaticMarkup(<PaymentReconciliation {...props} candidatesLoading />);
    expect(loading).toContain('role="status"');
    expect(loading).not.toContain('type="radio"');
    expect(loading).not.toContain('No hay cobros elegibles');
    const edited = renderToStaticMarkup(<PaymentReconciliation {...props} candidatesLoading={false} disabled />);
    expect(edited).toContain("Guarda o descarta los cambios");
  });
});

type ButtonProps = { readonly children?: ReactNode; readonly className?: string; readonly disabled?: boolean; readonly onClick?: () => void };
const primaryButton = (node: ReactNode): ReactElement<ButtonProps> => {
  const visit = (value: ReactNode): ReactElement<ButtonProps>[] => Children.toArray(value).flatMap(child => {
    if (!isValidElement<ButtonProps>(child)) return [];
    return [child, ...visit(child.props.children)];
  });
  const found = visit(node).find(child => child.type === "button" && child.props.className === "primary-button");
  if (!found) throw new Error("Confirmation button missing");
  return found;
};
