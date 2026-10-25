import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildMsiSchedule, computeMonthSummary } from "@finance/domain";
import { emptyPlanFor } from "../monthly-plan";
import { PlanningView, type PlanningViewProps } from "./PlanningView";

const now = new Date("2026-10-25T12:00:00-06:00");
const month = "2026-10";
const noIncomePlan = {
  ...emptyPlanFor(month),
  inheritedFromMonth: "2026-09",
  upcomingPayments: [{ id: "openai", name: "OpenAI", amountMinor: 399_00, dueDay: 18 }],
};
const summary = computeMonthSummary({
  month, now, incomeMinor: noIncomePlan.incomeMinor, incomeConfigured: noIncomePlan.configured,
  upcomingPaymentsMinor: 399_00,
  events: [{ id: "flight", amountMinor: 3_000_00, merchantRaw: "Vuelo",
    status: "accepted", receivedAt: "2026-09-01T12:00:00Z",
    msi: buildMsiSchedule({ principalMinor: 3_000_00, months: 3, startMonth: "2026-09", origin: "manual" }) }],
});

const propsFor = (overrides: Partial<PlanningViewProps> = {}): PlanningViewProps => ({
  month, now, monthMsiRows: summary.monthMsiRows, msiSpentMinor: summary.msiSpentMinor,
  msiCommittedMinor: summary.msiCommittedMinor, msiLoading: false,
  fixedPayments: noIncomePlan.upcomingPayments, inheritedFromMonth: noIncomePlan.inheritedFromMonth,
  billUpcomingMinor: summary.billUpcomingMinor, fixedPaymentsLoading: false,
  cards: [{ id: "santander", name: "Santander", cutOffDay: 4, paymentDueDay: 24 }], cardsLoading: false,
  onRetryMsi() {}, async onOpenMsiEvent() {}, onRetryFixedPayments() {}, onAddPayment() {},
  onEditPayment() {}, onRetryCards() {}, onAddCard() {}, onEditCard() {}, onOpenCommitments() {},
  ...overrides,
});

describe("Planificación's independent data sources", () => {
  it("shows MSI, programmed inherited payments and dates without payroll or valid liquidity", () => {
    expect(noIncomePlan.configured).toBe(false);
    expect(summary.incomeConfigured).toBe(false);
    const html = renderToStaticMarkup(<PlanningView {...propsFor()} />);
    expect(html).toContain("Planificación");
    expect(html).toContain("Vuelo");
    expect(html).toContain("Cuota 2/3");
    expect(html).toContain("OpenAI");
    expect(html).toContain("Según tus gastos fijos de sep 2026");
    expect(html).toContain("No confirma si ya se cobraron.");
    expect(html).toContain("Programado · cada mes");
    expect(html).toContain('aria-label="Calendario de corte y pago"');
    expect(html).not.toContain("Te quedan");
    expect(html).not.toContain("Falta tu nómina");
  });

  it("keeps fixed payments and card dates available when MSI summary fails", () => {
    const html = renderToStaticMarkup(<PlanningView {...propsFor({
      msiLoadError: "Resumen no disponible", billUpcomingMinor: undefined,
    })} />);
    expect(html).toContain("Resumen no disponible");
    expect(html).toContain("Reintentar MSI");
    expect(html).not.toContain("No hay cuotas MSI");
    expect(html).not.toContain("Vuelo");
    expect(html).toContain("OpenAI");
    expect(html).not.toContain("Total de gastos fijos programados");
    expect(html).toContain('aria-label="Calendario de corte y pago"');
  });

  it("does not turn loading or failed fixed payments into an empty list or hide MSI and dates", () => {
    for (const overrides of [
      { fixedPaymentsLoading: true },
      { fixedPaymentsLoadError: "Programación no disponible" },
    ]) {
      const html = renderToStaticMarkup(<PlanningView {...propsFor(overrides)} />);
      expect(html).toContain("Vuelo");
      expect(html).toContain('aria-label="Calendario de corte y pago"');
      expect(html).not.toContain("No hay gastos fijos programados");
      expect(html).not.toContain("Total de gastos fijos programados");
      expect(html).not.toContain("OpenAI");
    }
  });

  it("keeps financial sections and future commitments visible when cards fail", () => {
    const html = renderToStaticMarkup(<PlanningView {...propsFor({ cardsLoadError: "Tarjetas no disponibles" })} />);
    expect(html).toContain("Tarjetas no disponibles");
    expect(html).toContain("Vuelo");
    expect(html).toContain("OpenAI");
    expect(html).toContain("PRÓXIMOS COMPROMISOS");
    expect(html).not.toContain('aria-label="Calendario de corte y pago"');
  });

  it("separates the selected calendar month from the current future horizon and clamps scheduled dates", () => {
    const payment = { id: "mobile", name: "Celular", amountMinor: 469_00, dueDay: 31 };
    const html = renderToStaticMarkup(<PlanningView {...propsFor({
      month: "2026-02", monthMsiRows: [], fixedPayments: [payment],
      inheritedFromMonth: undefined, billUpcomingMinor: 469_00,
    })} />);
    expect(html).toContain("fechas de feb 2026, el mes elegido");
    expect(html).toContain("Desde oct 2026, el mes actual");
    expect(html).toContain("Este horizonte parte de hoy, aunque elijas otro mes.");
    expect(html).toContain('<small>FEB</small><strong>28</strong>');
    expect(payment.dueDay).toBe(31);
  });
});
