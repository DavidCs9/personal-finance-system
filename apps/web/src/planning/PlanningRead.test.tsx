import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { expect, it } from "vitest";
import { BudgetRead } from "./BudgetRead";
import { PlanningEntries } from "./FinancialPlanning";
import { IncomeRead } from "./IncomeRead";
import { budgetStatusQueryKey, expectedIncomeQueryKey, financialGoalsQueryKey } from "../lib/query-keys";
import { demoBudgetStatus, demoFinancialGoals, demoIncomeSchedule } from "../api/planning-demo";

const month = "2026-07";
const access = { idToken: "demo", demoMode: true };
const onOpen = async () => {};

const render = (client: QueryClient, element: ReactNode) =>
  renderToStaticMarkup(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
const clientForTest = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });

it("keeps a partial payroll amount unknown and displays real or recorded CFDI on its own", () => {
  const client = clientForTest();
  client.setQueryData(expectedIncomeQueryKey(month), {
    pages: [demoIncomeSchedule(month, "2026-09")], pageParams: [undefined],
  });
  const html = render(client, <IncomeRead month={month} access={access} onOpenPayslip={onOpen} />);
  expect(html).toContain("Neto por confirmar");
  expect(html).toContain("Mes parcial");
  expect(html).toContain("Remanente por confirmar");
  expect(html).toContain("Nómina CFDI registrada");
  expect(html).toContain("Ver recibo CFDI");
  expect(html).not.toContain("Subtotal conocido");
  client.clear();
});

it("distinguishes a pending query, failed query, and missing budget limit", async () => {
  const client = clientForTest();
  const view = <BudgetRead month={month} access={access} onOpenEvent={onOpen} />;
  expect(render(client, view)).toContain("Consultando presupuesto");
  await expect(client.fetchQuery({ queryKey: budgetStatusQueryKey(month), queryFn: async () => {
    throw new Error("Unavailable");
  } })).rejects.toThrow();
  const failed = render(client, view);
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("Reintentar");
  expect(failed).not.toContain("Sin límite configurado");
  client.setQueryData(budgetStatusQueryKey(month), { ...demoBudgetStatus(month), configured: false, budget: null });
  const empty = render(client, view);
  expect(empty).toContain("Sin límite configurado");
  expect(empty).toContain("Gasto del mes");
  expect(empty).not.toContain("Disponible por día");
  client.clear();
});

it("shows refreshed goal figures directly in Planificación and preserves access to archived and later records", () => {
  const client = clientForTest();
  const view = <PlanningEntries month={month} access={access} onOpen={() => {}} onOpenEvent={onOpen} />;
  const [goal] = demoFinancialGoals.goals;
  const read = (goals: typeof demoFinancialGoals.goals, nextCursor: string | null) => {
    client.setQueryData(financialGoalsQueryKey, { pages: [{ goals, nextCursor }], pageParams: [undefined] });
    return render(client, view);
  };
  const initial = read([goal!], null);
  expect(initial.indexOf("Viaje en familia")).toBeLessThan(initial.indexOf("Presupuesto del mes"));
  expect(initial).toContain("Pendiente total");
  expect(initial).toContain("$30,000.00");
  expect(initial).toContain("Todos los periodos");
  const next = read([
    { ...goal!, status: "archived" },
    { ...goal!, id: "example-studio", name: "Estudio de ejemplo", totalBudgetMxnMinor: 4_300_000,
      unallocatedMxnMinor: 1_280_000, remainingMxnMinor: 3_500_000 },
  ], "opaque-cursor");
  expect(next).toContain("$35,000.00");
  expect(next).toContain("Metas archivadas");
  expect(next).toContain("Ver más metas");
  expect(next.indexOf("Estudio de ejemplo")).toBeLessThan(next.indexOf("Metas archivadas"));
  client.clear();
});
