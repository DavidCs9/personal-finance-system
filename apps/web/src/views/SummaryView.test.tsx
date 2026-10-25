import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
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
  loading: false, risk: "steady", analyticsLoading: false,
  idToken: "demo", demoMode: true,
  onRetry() {}, onUploadNomina() {}, onOpenIncome() {},
  onOpenPlanning() {}, onOpenStatements() {},
  onReviewLargest() {}, onRetryAnalytics() {}, onOpenAnalytics() {}, onOpenAnalyticsMovements() {},
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

  it("places compact navigation after the financial core and before analysis", () => {
    const html = renderToStaticMarkup(<SummaryView {...propsFor()} />);
    const numbers = html.indexOf('class="number-grid"');
    const planning = html.indexOf('<strong>Planificación</strong>');
    const statements = html.indexOf('<strong>Estados de cuenta</strong>');
    const analytics = html.indexOf('class="analytics-preview"');

    expect(numbers).toBeGreaterThan(-1);
    expect(planning).toBeGreaterThan(numbers);
    expect(statements).toBeGreaterThan(planning);
    expect(analytics).toBeGreaterThan(statements);
    expect(html).toContain("PDF registrados y cortes faltantes · todas las fechas");
    for (const removedClass of ["payslip-month-section", "msi-section", "payments-section", "card-cycle-section"]) {
      expect(html).not.toContain(`class="${removedClass}`);
    }
  });

  it.each(["loaded", "loading", "error", "missing-income"] as const)(
    "keeps planning and all-date statements reachable when %s",
    (state) => {
      const props = propsFor();
      const onOpenPlanning = vi.fn();
      const onOpenStatements = vi.fn();
      const overrides: Partial<SummaryViewProps> = state === "loading"
        ? { loading: true }
        : state === "error"
          ? { loadError: "No disponible" }
          : state === "missing-income"
            ? { plan: { ...props.plan, configured: false, incomeMinor: 0 } }
            : {};
      const current = { ...props, ...overrides, onOpenPlanning, onOpenStatements };
      const html = renderToStaticMarkup(<SummaryView {...current} />);
      const view = SummaryView(current);

      expect(html).toContain('<strong>Planificación</strong>');
      expect(html).toContain('<strong>Estados de cuenta</strong>');
      expect(html).toContain("PDF registrados y cortes faltantes · todas las fechas");
      buttonFor(view, onOpenPlanning).props.onClick?.();
      buttonFor(view, onOpenStatements).props.onClick?.();
      expect(onOpenPlanning).toHaveBeenCalledOnce();
      expect(onOpenStatements).toHaveBeenCalledOnce();
      if (state !== "loaded") {
        expect(html).not.toContain('class="spend-commitments-amount"');
        expect(html).not.toContain("Te quedan");
        expect(html).not.toContain("Gastarás");
      }
    },
  );

  it("preserves provisional and estimated liquidity notices and its income action", () => {
    const props = propsFor();
    const onOpenIncome = vi.fn();
    const provisional = {
      ...props,
      onOpenIncome,
      plan: { ...props.plan, provisionalActive: true, provisionalMinor: props.plan.incomeMinor },
    };
    const html = renderToStaticMarkup(<SummaryView {...provisional} />);
    expect(html).toContain("Liquidez provisional · pendiente nómina de este mes");
    // The liquidity chip retains its existing route into Nómina del mes.
    const chip = findElement(SummaryView(provisional), (element) => element.props.className === "income-button");
    expect(chip).toBeDefined();
    chip!.props.onClick?.();
    expect(onOpenIncome).toHaveBeenCalledOnce();

    const estimate = renderToStaticMarkup(<SummaryView {...props} plan={{
      ...props.plan, estimateActive: true, estimatedMinor: 5_000_00,
    }} />);
    expect(estimate).toContain('Incluye <span class="amt">$5,000</span> estimado de la 2ª quincena');
  });
});

type ElementProps = { readonly children?: ReactNode; readonly onClick?: () => void; readonly className?: string };

const findElement = (
  node: ReactNode,
  predicate: (element: ReactElement<ElementProps>) => boolean,
): ReactElement<ElementProps> | undefined => {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (predicate(child)) return child;
    const nested = findElement(child.props.children, predicate);
    if (nested) return nested;
  }
  return undefined;
};

const buttonFor = (view: ReactNode, onClick: () => void): ReactElement<ElementProps> => {
  const button = findElement(view, (element) => element.type === "button" && element.props.onClick === onClick);
  expect(button).toBeDefined();
  return button!;
};
