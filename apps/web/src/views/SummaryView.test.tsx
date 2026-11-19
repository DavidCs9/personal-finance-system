import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { computeMonthSummary, monthCashLiquidity, monthDashboardLiquidity, monthDashboardSpending,
  summarizePostedCredits, summarizeFutureIncome, type BankCredit, type IncomeOccurrence } from "@finance/domain";
import { demoBudgetStatus } from "../api/planning-demo";
import type { MonthDashboard } from "../api/planning-types";
import { SummaryView, type SummaryViewProps } from "./SummaryView";
import { MonthEntries, MonthEntryDetail } from "./MonthEntries";

const now = new Date("2026-07-12T18:00:00-06:00");
const month = "2026-07";
const credit = (id: string, values: Partial<BankCredit> = {}): BankCredit => ({ movementId:id,
  creditType:"income", incomeType:"otro", accountKind:"cash", institution:"santander_mx", accountLastFour:"1234",
  currency:"MXN", amountMinor:4500_00, postedOn:"2026-07-11", description:"Venta de monitor",
  evidenceReference:`BANK-${id}`, fundEmployerKey:null, ...values });
const expected: IncomeOccurrence = { incomeId:"salary", occurrenceId:"salary:2026-07:0", name:"Nómina de prueba",
  employer:"Empresa de prueba", paymentDate:"2026-07-31", periodMonth:month, amountMxnMinor:18000_00,
  scheduleBasis:"regular", confidence:"estimated", basis:"configured_expectation_not_received_income", reconciliationStatus:"unreconciled" };
const dashboardFor = (credits: BankCredit[] = [], occurrences: IncomeOccurrence[] = [expected]): MonthDashboard => {
  const summary = computeMonthSummary({ month, now, events:[], incomeMinor:0, incomeConfigured:false, upcomingPaymentsMinor:0 });
  const budget=demoBudgetStatus(month, undefined, true);
  return { month, generatedAt:now.toISOString(), summary:{...summary,remainingMinor:null,projectedRemainingMinor:null}, budget,
    spending:monthDashboardSpending(summary,budget), liquidity:monthDashboardLiquidity(summary,{},true),
    cash:monthCashLiquidity(month,now,[]),postedCredits:summarizePostedCredits(credits),
    futureIncome:summarizeFutureIncome(month,now,occurrences,false),payrollFundClosures:[] };
};
const propsFor = (dashboard?: MonthDashboard): SummaryViewProps => ({ month,dashboard,spentMinor:850_00,uncertainMinor:100_00,
  analyticsLoading:false,onRetryAnalytics(){},onOpenAnalytics(){},onOpenAnalyticsMovements(){},onOpenBudget(){},onRetryDashboard(){} });

 describe("simple monthly Resumen",()=>{
  it("shows recorded spending above categories even when the budget excludes part of it", () => {
    const base = dashboardFor();
    const html = renderToStaticMarkup(<SummaryView {...propsFor({
      ...base, spending: { ...base.spending, recordedMinor: 194_562_31 },
      budget: { ...base.budget, countedSpentMxnMinor: 100_00, excludedSpentMxnMinor: 194_462_31 },
    })} />);
    expect(html.indexOf("Gasto total del mes")).toBeLessThan(html.indexOf("En qué se fue"));
    expect(html).toContain("$194,562.31");
    expect(html).toContain("Incluye gastos fuera del presupuesto");
  });
  it("keeps all spending before generic entries and removes duplicated cash/payroll/navigation",()=>{
    const html=renderToStaticMarkup(<SummaryView {...propsFor(dashboardFor())} />);
    const headings=["Presupuesto mensual","Ritmo de gasto","En qué se fue","Entradas del mes"].map(label=>html.indexOf(label));
    expect(headings.every(index=>index>=0)).toBe(true);
    expect(headings).toEqual([...headings].sort((a,b)=>a-b));
    for(const removed of ["Saldos de efectivo","Liquidez al cierre","Nómina y compromisos","Abonos del mes","Avisos de Olbia","Explora tu mes"])
      expect(html).not.toContain(removed);
    expect(html).not.toContain("Falta tu nómina");
    expect(html).not.toContain("<dt>Margen</dt>");
    expect(html).toContain("Detalle e historial");
    expect(html).toContain("Ver análisis");
  });
  it("keeps budget warnings and hides quantitative graphics in private mode",()=>{
    const dashboard=dashboardFor();
    const warning={...dashboard,budget:{...dashboard.budget,warningWithCommitments:"90" as const}};
    expect(renderToStaticMarkup(<SummaryView {...propsFor(warning)} />)).toContain("Cerca del límite");
    expect(renderToStaticMarkup(<SummaryView {...propsFor(dashboard)} />)).toContain("<canvas");
    expect(renderToStaticMarkup(<SummaryView {...propsFor(dashboard)} privateMode />)).not.toMatch(/<canvas|class="summary-budget-meter"/);
  });
  it("does not turn loading or failed bank reads into zero income",()=>{
    const loading=renderToStaticMarkup(<SummaryView {...propsFor()} dashboardLoading />);
    expect(loading).toContain("Consultando entradas");expect(loading).not.toContain("$0");
    const failed=renderToStaticMarkup(<SummaryView {...propsFor()} dashboardError spendAvailable />);
    expect(failed).toContain("No pudimos consultar las entradas");expect(failed).toContain("$850");
    expect(failed).toContain("$100");expect(failed).not.toContain("Sin registros");
    const stale=renderToStaticMarkup(<SummaryView {...propsFor(dashboardFor())} dashboardError />);
    expect(stale).toContain("Se muestra la última lectura");expect(stale).toContain("Entradas del mes");
  });
 });

 describe("generic monthly entries",()=>{
  it("shows mixed manual income/refunds and expectations without double counting card refunds",()=>{
    const dashboard=dashboardFor([credit("severance",{incomeType:"finiquito",description:"Finiquito de prueba",amountMinor:82000_00}),
      credit("refund",{creditType:"refund",incomeType:null,description:"Devolución de prueba",amountMinor:1850_00}),credit("sale"),
      credit("card",{creditType:"refund",incomeType:null,accountKind:"credit_card",description:"Reembolso a tarjeta de prueba",amountMinor:999_99})]);
    const html=renderToStaticMarkup(<MonthEntries month={month} dashboard={dashboard} />);
    for(const name of ["Finiquito de prueba","Nómina de prueba","Devolución de prueba","Venta de monitor"])expect(html).toContain(name);
    expect(html).toContain("$88,350");expect(html).toContain("$18,000");expect(html).not.toContain("$106,350");
    expect(html).toContain("Devoluciones a tarjeta");expect(html).toContain("$999.99");expect(html).not.toContain("$89,349.99");
  });
  it("preserves unknown, overdue, overlap and incomplete expectations instead of promising a deposit",()=>{
    for(const futureIncome of [summarizeFutureIncome(month,now,[{...expected,amountMxnMinor:null,paymentDate:null}],false),
      summarizeFutureIncome(month,now,[{...expected,paymentDate:"2026-07-10"}],false),
      summarizeFutureIncome(month,now,[{...expected,reconciliationStatus:"possible_payroll_overlap"}],false),
      summarizeFutureIncome(month,now,[expected],false,true)]) {
      const html=renderToStaticMarkup(<MonthEntries month={month} dashboard={{...dashboardFor(),futureIncome}} />);
      expect(html).toContain("Sin registros");expect(html).not.toContain("$0");
      expect(html).toContain(futureIncome.status==="reconciliation_needed"?"Por conciliar":"Por confirmar");
      if(futureIncome.hasMore)expect(html).toContain("programación está incompleta");
    }
  });
  it("keeps posted evidence and expectation detail distinct, with private-mode amount markers",()=>{
    const posted=renderToStaticMarkup(<MonthEntryDetail entry={{kind:"posted",credit:credit("refund",{creditType:"refund",incomeType:null})}} needsReconciliation={false} />);
    expect(posted).toContain("BANK-refund");expect(posted).toContain("Santander");expect(posted).toContain("no modifica la compra original");
    expect(posted).toContain('class="amt"');expect(posted).toContain('class="plan-sensitive"');
    const planned=renderToStaticMarkup(<MonthEntryDetail entry={{kind:"expected",occurrence:expected}} needsReconciliation />);
    expect(planned).toContain("Por conciliar");expect(planned).toContain("no se considera dinero recibido");
  });
  it("does not show future expectations on a closed month and does not fabricate cash from payroll",()=>{
    const dashboard=dashboardFor();
    const html=renderToStaticMarkup(<MonthEntries month="2026-06" dashboard={{...dashboard,
      futureIncome:summarizeFutureIncome("2026-06",now,[{...expected,periodMonth:"2026-06",paymentDate:"2026-06-30"}],false)}} />);
    expect(html).toContain("Mes cerrado");expect(html).toContain("Sin registros");expect(html).not.toContain("Nómina de prueba");
  });
 });
