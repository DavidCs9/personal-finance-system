import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildMsiSchedule, computeMonthSummary, markInstallmentSpent, type MonthSpendEvent } from "@finance/domain";
import { SummaryView, type SummaryViewProps } from "./SummaryView";

const now = new Date("2026-08-04T12:00:00-06:00");
const pendingPlan = buildMsiSchedule({
  principalMinor: 2_250_00, months: 3, startMonth: "2026-08", origin: "manual",
});
const spentPlan = markInstallmentSpent(buildMsiSchedule({
  principalMinor: 1_500_00, months: 3, startMonth: "2026-07", origin: "manual",
}), 2, { amountMinor: 500_00, confirmedAt: now.toISOString() });

const events: readonly MonthSpendEvent[] = [
  { amountMinor: 1_000_00, personalAmountMinor: 250_00, status: "accepted", receivedAt: now.toISOString() },
  { amountMinor: 100_00, status: "needs_review", receivedAt: now.toISOString() },
  ...["rejected", "pending_foreign", "deferred_msi"].map((status) => ({
    amountMinor: 10_000_00, status, receivedAt: now.toISOString(),
  })),
  { amountMinor: 1_500_00, status: "accepted", receivedAt: "2026-07-04T12:00:00Z", msi: spentPlan },
  { amountMinor: 2_250_00, status: "accepted", receivedAt: now.toISOString(), msi: pendingPlan },
];

const propsFor = (sourceEvents = events): SummaryViewProps => ({
  ...computeMonthSummary({
    events: sourceEvents, month: "2026-08", incomeMinor: 10_000_00,
    incomeConfigured: true, upcomingPaymentsMinor: 2_000_00, now,
  }),
  month: "2026-08",
  plan: {
    month: "2026-08", configured: true, currency: "MXN", incomeMinor: 10_000_00,
    upcomingPayments: [{ id: "rent", name: "Renta", amountMinor: 2_000_00, dueDay: 15 }],
  },
  loading: false, risk: "steady", analyticsLoading: false, cardsLoading: false,
  cards: [], now, idToken: "demo", demoMode: true,
  onRetry() {}, onUploadNomina() {}, onOpenIncome() {}, onOpenPayslip() {},
  onAddPayment() {}, onEditPayment() {}, onOpenMsiEvent() {}, onOpenCommitments() {},
  onReviewLargest() {}, onRetryAnalytics() {}, onOpenAnalytics() {}, onOpenAnalyticsMovements() {},
  onRetryCards() {}, onAddCard() {}, onEditCard() {},
});

describe("Resumen's recorded spend and commitments", () => {
  it("uses the canonical financial summary and keeps the combined total stable when MSI is confirmed", () => {
    const before = renderToStaticMarkup(<SummaryView {...propsFor()} />);
    const confirmed = events.map((event) => event.msi === pendingPlan
      ? { ...event, msi: markInstallmentSpent(pendingPlan, 1, { amountMinor: 750_00, confirmedAt: now.toISOString() }) }
      : event);
    const after = renderToStaticMarkup(<SummaryView {...propsFor(confirmed)} />);

    // Mi parte + uncertain spend + this month's confirmed cuota; no rejected/foreign/deferred principal.
    expect(before).toContain('class="hero-amount"><span class="amt">$850</span>');
    expect(after).toContain('class="hero-amount"><span class="amt">$1,600</span>');
    for (const html of [before, after]) {
      expect(html).toContain('class="spend-commitments-amount"><span class="amt">$3,600</span>');
      expect(html).toContain('<span class="amt">36%</span>');
      expect(html).toContain('<span class="amt">$6,400</span>');
      expect(html).toContain('Incluye <span class="amt">$100</span> por confirmar');
      expect(html).toContain("Los fijos muestran lo programado para el mes; aún no verificamos si ya se cobraron.");
    }
  });

  it("does not present the combined percentage or availability as valid without loaded, valid liquidity", () => {
    const props = propsFor();
    for (const overrides of [
      { loading: true },
      { loadError: "No disponible" },
      { plan: { ...props.plan, configured: false, incomeMinor: 0 } },
    ]) {
      const html = renderToStaticMarkup(<SummaryView {...props} {...overrides} />);
      expect(html).not.toContain('class="spend-commitments-amount"');
      expect(html).not.toContain("Te quedan");
    }
  });
});
