import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FixedPaymentsSection } from "./FixedPaymentsSection";

it("keeps scheduled total and each fixed-payment amount while distinguishing reconciliation states", () => {
  const reconciliation = { eventId: "charge", merchantRaw: "OPENAI", amountMinor: 0,
    grossAmountMinor: 399_00, occurredAt: "2026-10-18T12:00:00Z", valid: true };
  const html = renderToStaticMarkup(<FixedPaymentsSection month="2026-10" loading={false} totalMinor={1_197_00}
    payments={[{ id: "one", name: "First", amountMinor: 399_00, dueDay: 18, reconciliation },
      { id: "two", name: "Second", amountMinor: 399_00, dueDay: 18, reconciliation: { ...reconciliation, valid: false } },
      { id: "three", name: "Third", amountMinor: 399_00, dueDay: 18 }]}
    onRetry={() => {}} onAdd={() => {}} onEdit={() => {}} />);
  expect(html).toContain("Cobro vinculado");
  expect(html).toContain("Revisar vínculo");
  expect(html).toContain("Por conciliar");
  expect(html.match(/\$399/g)).toHaveLength(3);
  expect(html.match(/\$1,197/g)).toHaveLength(2);
  expect(html).toContain("Total de gastos fijos programados");
});
