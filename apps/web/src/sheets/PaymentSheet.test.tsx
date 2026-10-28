import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PaymentSheet } from "./PaymentSheet";
import type { PlannedPayment } from "../monthly-plan";

const payment: PlannedPayment = { id: "fixed", name: "OpenAI", amountMinor: 399_00, dueDay: 18 };
const props = { month: "2026-10", candidates: [], candidatesLoading: false, onClose() {}, async onSave() {}, async onDelete() {}, async onReconcile() {} };

describe("fixed-payment editor reconciliation boundaries", () => {
  it("requires a saved fixed payment before linking and allows deleting an unlinked one", () => {
    const fresh = renderToStaticMarkup(<PaymentSheet {...props} />);
    expect(fresh).toContain("Guarda el gasto fijo antes de vincular");
    expect(fresh).not.toContain('aria-label="Conciliación del gasto fijo"');
    const existing = renderToStaticMarkup(<PaymentSheet {...props} payment={payment} />);
    expect(existing).toContain('class="delete-button" type="button">Eliminar gasto fijo');
    expect(existing).toContain("Por conciliar");
  });

  it("blocks deletion for both valid and invalid current links until explicitly unlinked", () => {
    for (const valid of [true, false]) {
      const linked = { ...payment, reconciliation: { eventId: "charge", merchantRaw: "OPENAI", amountMinor: 0,
        grossAmountMinor: 399_00, occurredAt: "2026-10-18T12:00:00Z", valid } };
      const html = renderToStaticMarkup(<PaymentSheet {...props} payment={linked} />);
      expect(html).toContain('class="delete-button" type="button" disabled=""');
      expect(html).toContain("Desvincula el cobro antes de eliminar");
      expect(html).toContain(valid ? "Cobro vinculado" : "Revisar vínculo");
    }
  });
});
