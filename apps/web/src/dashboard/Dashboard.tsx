import { useEffect, useMemo, useState } from "react";
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ledgerApi } from "../api/client";
import type { MonthDashboard } from "../api/planning-types";
import { demoBudgetStatus, demoMonthCredits, demoMonthFutureIncome } from "../api/planning-demo";
import { mockAnalyticsFor, mockExceptionRawEmail, mockExceptions, mockFeedForMonth, mockMonthSummaryFor, mockEvents } from "../api/mock-data";
import { useMarketWealthSync } from "./useMarketWealthSync";
import { AppShell } from "../layout/AppShell";
import { eventDate, monthKey } from "../lib/format";
import { usePrivateMode } from "../lib/private-mode";
import { analyticsQueryKey, analyticsQueryRoot, eventsQueryKey, eventsQueryRoot, exceptionsQueryKey, monthDashboardQueryKey, monthlyPlanQueryKey, monthlyPlanQueryRoot, monthlySummaryQueryKey, monthlySummaryQueryRoot, cardsQueryKey, wealthQueryKey, commitmentsQueryRoot, statementsQueryKey, budgetQueryRoot, financialGoalsQueryRoot, financialPlanningQueryRoot, expectedIncomeQueryRoot } from "../lib/query-keys";
import { FinancialPlanningDialog, PlanningEntries } from "../planning/FinancialPlanning";
import type { PlanningPane } from "../planning/PlanningRead";
import type { Tab } from "../lib/tabs";
import {
  demoPlans,
  planFor,
  type MonthlyPlan,
  type PlannedPayment,
} from "../monthly-plan";
import { demoCards } from "../card-cycle-demo";
import type { CardCycle } from "../card-cycle";
import { CommitmentsSheet } from "../sheets/CommitmentsSheet";
import { EventSheet } from "../sheets/EventSheet";
import { NominaUploadSheet } from "../sheets/NominaUploadSheet";
import { PayslipSheet } from "../sheets/PayslipSheet";
import type { Payslip } from "../monthly-plan";
import { CashBalanceSheet } from "../sheets/CashBalanceSheet";
import { PayrollClosureSheet } from "../sheets/PayrollClosureSheet";
import { CardLiabilitySheet } from "../sheets/CardLiabilitySheet";
import { ManualEntrySheet } from "../sheets/ManualEntrySheet";
import { FixedExpenseSheet } from "../sheets/FixedExpenseSheet";
import { PaymentSheet } from "../sheets/PaymentSheet";
import { CardSheet } from "../sheets/CardSheet";
import { SantanderImportSheet } from "../sheets/SantanderImportSheet";
import { StatementsSheet } from "../sheets/StatementsSheet";
import { StatementImportSheet } from "../sheets/StatementImportSheet";
import { AmexActivitySheet } from "../sheets/AmexActivitySheet";
import type { EventFeed, PurchaseEvent } from "../types";
import { MovementsView } from "../views/MovementsView";
import { SummaryView } from "../views/SummaryView";
import { PushPreference } from "../components/PushPreference";
import { PlanningReadDialog } from "../planning/PlanningRead";
import { PlanningView } from "../views/PlanningView";
import { WealthView } from "../views/WealthView";
import { AnalyticsView } from "../views/AnalyticsView";
import { demoWealthOverview } from "../wealth-demo";
import type { WealthOverview, WealthAccountView, WealthHistoryPoint, WealthLiabilityView } from "../wealth";
import { withWealthTotals } from "../wealth";
import { SANTANDER_CASH_ACCOUNT_ID, BITSO_ACCOUNT_ID, IBKR_ACCOUNT_ID, WEALTH_ACCOUNTS, dayKeyInZone, manualCashHolding,
  monthCashLiquidity, monthDashboardLiquidity, monthDashboardSpending, summarizePostedCredits,
  type ManualCashAccountId, type WealthAccountId, type WealthSnapshot } from "@finance/domain";

const reconcileDemoPayment = (plan: MonthlyPlan, paymentId: string, eventId: string | null,
  expectedEventId: string | null, expectedPayment: Pick<PlannedPayment, "name" | "amountMinor" | "dueDay">,
  events: readonly PurchaseEvent[], month: string): MonthlyPlan => {
  const payment = plan.upcomingPayments.find(item => item.id === paymentId);
  if (!payment || (payment.reconciliation?.eventId ?? null) !== expectedEventId
    || payment.name !== expectedPayment.name || payment.amountMinor !== expectedPayment.amountMinor || payment.dueDay !== expectedPayment.dueDay) {
    throw new Error("El vínculo cambió. Cierra este detalle y vuelve a abrirlo.");
  }
  const event = eventId ? events.find(item => item.id === eventId) : undefined;
  if (eventId && (!event || event.msi || event.amount.currency !== "MXN" || event.amount.amountMinor <= 0
    || !["accepted", "needs_review"].includes(event.status) || monthKey(new Date(event.occurredAt ?? event.receivedAt)) !== month)) {
    throw new Error("Elige un cargo válido de este mes.");
  }
  if (eventId && plan.upcomingPayments.some(item => item.id !== paymentId && item.reconciliation?.eventId === eventId)) {
    throw new Error("Ese cargo ya está vinculado a otro gasto fijo.");
  }
  return { ...plan, upcomingPayments: plan.upcomingPayments.map(item => {
    if (item.id !== paymentId) return item;
    const { reconciliation: _previous, ...value } = item;
    return event ? { ...value, reconciliation: { eventId: event.id, merchantRaw: event.merchantRaw,
      amountMinor: event.personalAmountMinor ?? event.amount.amountMinor, grossAmountMinor: event.amount.amountMinor,
      occurredAt: new Date(event.occurredAt ?? event.receivedAt).toISOString(), valid: true } } : value;
  }) };
};

export function Dashboard({
  idToken,
  demoMode,
  onSignOut,
}: {
  idToken: string;
  demoMode: boolean;
  onSignOut(): void;
}) {
  const now = useMemo(
    () => (demoMode ? new Date("2026-07-12T18:00:00-06:00") : new Date()),
    [demoMode],
  );
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("summary");
  const currentMonth = monthKey(now);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [planningPane, setPlanningPane] = useState<PlanningPane>();
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [activePayslip, setActivePayslip] = useState<Payslip>();
  const [uploadingNomina, setUploadingNomina] = useState(false);
  const [fixedExpenseEditor, setFixedExpenseEditor] = useState<{ month: string; id?: string }>();
  const [editingPayment, setEditingPayment] = useState<PlannedPayment | null | undefined>();
  useEffect(() => { setEditingPayment(undefined); }, [selectedMonth]);
  const [editingCard, setEditingCard] = useState<CardCycle | null | undefined>();
  const [activeEvent, setActiveEvent] = useState<PurchaseEvent>();
  const [movementSort, setMovementSort] = useState<"recent" | "largest">("recent");
  const [commitmentsOpen, setCommitmentsOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [movementEvidenceFilter, setMovementEvidenceFilter] = useState<{
    readonly label: string;
    readonly eventIds: readonly string[];
  }>();
  const [statementsOpen, setStatementsOpen] = useState(false);
  const [resumeStatementId, setResumeStatementId] = useState<string>();
  const [returnToStatements, setReturnToStatements] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [amexImportOpen, setAmexImportOpen] = useState(false);
  const [amexActivityOpen, setAmexActivityOpen] = useState(false);
  const [santanderStatementOpen, setSantanderStatementOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [cashAccount, setCashAccount] = useState<ManualCashAccountId>();
  const [payrollCloseOpen, setPayrollCloseOpen] = useState(false);
  const [liabilityCard, setLiabilityCard] = useState<WealthLiabilityView>();
  const [selectedWealthAccount, setSelectedWealthAccount] = useState<WealthAccountId | "all">("all");
  const { privateMode, togglePrivateMode } = usePrivateMode();

  const eventsQuery = useQuery({
    queryKey: eventsQueryKey(selectedMonth),
    queryFn: () =>
      demoMode ? Promise.resolve(mockFeedForMonth(selectedMonth)) : ledgerApi.listEvents(idToken, selectedMonth),
  });
  const exceptionsQuery = useQuery({
    queryKey: exceptionsQueryKey,
    queryFn: () =>
      demoMode
        ? Promise.resolve({ exceptions: mockExceptions })
        : ledgerApi.listExceptions(idToken),
  });
  const dashboardQuery = useQuery({
    queryKey: monthDashboardQueryKey(selectedMonth),
    enabled: tab === "summary" && !analyticsOpen,
    queryFn: () => {
      if (!demoMode) return ledgerApi.monthlyDashboard(selectedMonth, idToken);
      const demoPlan = queryClient.getQueryData<MonthlyPlan>(monthlyPlanQueryKey(selectedMonth)) ?? planFor(demoPlans, selectedMonth);
      const summary = mockMonthSummaryFor(selectedMonth, demoPlan, now);
      const budget = demoBudgetStatus(selectedMonth, demoPlan, true);
      return Promise.resolve({
        month: selectedMonth, generatedAt: now.toISOString(),
        summary: { ...summary, remainingMinor: null, projectedRemainingMinor: null }, budget,
        spending: monthDashboardSpending(summary, budget),
        liquidity: monthDashboardLiquidity(summary, demoPlan, true),
        cash: monthCashLiquidity(selectedMonth, now, []),
        monthlyReceived: queryClient.getQueryData<MonthDashboard>(monthDashboardQueryKey(selectedMonth))?.monthlyReceived ?? null,
        postedCredits: summarizePostedCredits(demoMonthCredits(selectedMonth)),
        futureIncome: demoMonthFutureIncome(selectedMonth),
        payrollFundClosures: [],
      });
    },
  });
  const monthlyPlanQuery = useQuery({
    queryKey: monthlyPlanQueryKey(selectedMonth),
    enabled: tab !== "summary" || dashboardQuery.isError,
    queryFn: () =>
      demoMode
        ? Promise.resolve(queryClient.getQueryData<MonthlyPlan>(monthlyPlanQueryKey(selectedMonth)) ?? planFor(demoPlans, selectedMonth))
        : ledgerApi.monthlyPlan(selectedMonth, idToken),
  });
  const monthlySummaryQuery = useQuery({
    queryKey: monthlySummaryQueryKey(selectedMonth),
    enabled: tab !== "summary" || dashboardQuery.isError,
    queryFn: () =>
      demoMode
        ? Promise.resolve(mockMonthSummaryFor(selectedMonth, queryClient.getQueryData<MonthlyPlan>(monthlyPlanQueryKey(selectedMonth)) ?? planFor(demoPlans, selectedMonth), now))
        : ledgerApi.monthlySummary(selectedMonth, idToken),
  });
  const analyticsQuery = useQuery({
    queryKey: analyticsQueryKey(selectedMonth),
    enabled: tab === "summary" && (analyticsOpen || dashboardQuery.isError),
    queryFn: () =>
      demoMode
        ? Promise.resolve(mockAnalyticsFor(selectedMonth, now))
        : ledgerApi.analytics(selectedMonth, idToken),
  });
  const cardsQuery = useQuery({
    queryKey: cardsQueryKey,
    queryFn: () =>
      demoMode
        ? Promise.resolve({ cards: demoCards })
        : ledgerApi.listCards(idToken),
  });
  const wealthQuery = useQuery({
    queryKey: wealthQueryKey,
    queryFn: () =>
      demoMode ? Promise.resolve(demoWealthOverview) : ledgerApi.wealth(idToken),
  });

  const bitsoSyncMutation = useMarketWealthSync(BITSO_ACCOUNT_ID, idToken, demoMode, now);
  const ibkrSyncMutation = useMarketWealthSync(IBKR_ACCOUNT_ID, idToken, demoMode, now);

  const events = eventsQuery.data?.events ?? [];
  const msiRelated = eventsQuery.data?.msiRelated ?? [];
  const exceptions = exceptionsQuery.data?.exceptions ?? [];
  const plan = monthlyPlanQuery.data ?? planFor({}, selectedMonth);
  const cards = cardsQuery.data?.cards ?? [];
  const wealth = wealthQuery.data;
  // A refetch keeps cached data visible. Only an initial load earns a full loader.
  const loading = eventsQuery.isPending;
  const error =
    eventsQuery.error instanceof Error
      ? eventsQuery.error.message
      : eventsQuery.error
        ? "No se pudieron cargar los movimientos."
        : undefined;
  const planLoading = monthlyPlanQuery.isPending;
  const planLoadError =
    monthlyPlanQuery.error instanceof Error
      ? monthlyPlanQuery.error.message
      : monthlyPlanQuery.error
        ? "No se pudo cargar la configuración del mes."
        : undefined;
  const cardsLoading = cardsQuery.isPending;
  const cardsLoadError =
    cardsQuery.error instanceof Error
      ? cardsQuery.error.message
      : cardsQuery.error
        ? "No se pudieron cargar tus tarjetas."
        : undefined;
  const wealthLoading = wealthQuery.isPending;
  const wealthLoadError =
    wealthQuery.error instanceof Error
      ? wealthQuery.error.message
      : wealthQuery.error
        ? "No se pudo cargar tu patrimonio."
        : undefined;

  const refreshPlanningEvidence = () => {
    void queryClient.invalidateQueries({ queryKey: budgetQueryRoot });
    void queryClient.invalidateQueries({ queryKey: financialGoalsQueryRoot });
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: financialPlanningQueryRoot });
    void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
    void queryClient.invalidateQueries({ queryKey: exceptionsQueryKey });
    void queryClient.invalidateQueries({ queryKey: monthlyPlanQueryKey(selectedMonth) });
    void queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot });
    void queryClient.invalidateQueries({ queryKey: analyticsQueryRoot });
    void queryClient.invalidateQueries({ queryKey: commitmentsQueryRoot });
    void queryClient.invalidateQueries({ queryKey: cardsQueryKey });
    void queryClient.invalidateQueries({ queryKey: wealthQueryKey });
    void queryClient.invalidateQueries({ queryKey: statementsQueryKey });
  };
  const closeStatementImport = () => {
    setAmexImportOpen(false);
    setSantanderStatementOpen(false);
    setResumeStatementId(undefined);
    setStatementsOpen(returnToStatements);
    setReturnToStatements(false);
    void queryClient.invalidateQueries({ queryKey: statementsQueryKey });
  };

  const retryExceptionMutation = useMutation({
    mutationFn: async (exceptionId: string) => {
      if (demoMode) {
        queryClient.setQueryData<{ exceptions: typeof mockExceptions }>(exceptionsQueryKey, (current) => ({
          exceptions: (current?.exceptions ?? mockExceptions).map((item) =>
            item.id === exceptionId
              ? { ...item, retry: { status: "queued" as const } }
              : item,
          ),
        }));
        return;
      }
      return ledgerApi.retryException(exceptionId, idToken);
    },
    onSuccess: () => {
      if (!demoMode) void queryClient.invalidateQueries({ queryKey: exceptionsQueryKey });
    },
  });
  const retryException = async (exceptionId: string) => {
    await retryExceptionMutation.mutateAsync(exceptionId);
  };
  const discardExceptionMutation = useMutation({
    mutationFn: async (exceptionId: string) => {
      if (demoMode) {
        queryClient.setQueryData<{ exceptions: typeof mockExceptions }>(exceptionsQueryKey, (current) => ({
          exceptions: (current?.exceptions ?? mockExceptions).filter((item) => item.id !== exceptionId),
        }));
        return;
      }
      return ledgerApi.discardException(exceptionId, idToken);
    },
    onSuccess: () => {
      if (!demoMode) void queryClient.invalidateQueries({ queryKey: exceptionsQueryKey });
    },
  });
  const discardException = async (exceptionId: string) => {
    await discardExceptionMutation.mutateAsync(exceptionId);
  };
  const readExceptionRaw = (exceptionId: string) =>
    demoMode
      ? Promise.resolve(mockExceptionRawEmail(exceptionId))
      : ledgerApi.rawException(exceptionId, idToken);

  const summaryEvents = useMemo(
    () => [...events, ...msiRelated],
    [events, msiRelated],
  );
  const dashboard = tab === "summary" && !dashboardQuery.isError ? dashboardQuery.data : undefined;
  const summary = dashboard?.summary ?? monthlySummaryQuery.data;
  const spentMinor = summary?.spentMinor ?? 0;
  const uncertainMinor = summary?.uncertainMinor ?? 0;
  const billUpcomingMinor = summary?.billUpcomingMinor ?? 0;
  const remainingMinor = summary?.remainingMinor ?? 0;
  const projectedRemainingMinor = summary?.projectedRemainingMinor ?? 0;
  const projectedSpendMinor = summary?.projectedSpendMinor ?? 0;
  const isCurrentMonth = summary?.isCurrentMonth ?? false;
  const msiSpentMinor = summary?.msiSpentMinor ?? 0;
  const msiCommittedMinor = summary?.msiCommittedMinor ?? 0;
  const monthMsiRows = summary?.monthMsiRows ?? [];

  const openMsiEvent = async (eventId: string, signal: AbortSignal) => {
    if (signal.aborted) return;
    const found = summaryEvents.find((event) => event.id === eventId)
      ?? (demoMode ? mockEvents.find((event) => event.id === eventId) : await ledgerApi.event(eventId, idToken));
    if (signal.aborted) return;
    if (!found) throw new Error("No pudimos encontrar esta compra.");
    setActiveEvent(found);
  };
  const openPlanningPayslip = async (month: string, id: string, signal: AbortSignal) => {
    if (signal.aborted) return;
    const record = month === selectedMonth && monthlyPlanQuery.data ? monthlyPlanQuery.data
      : demoMode ? planFor(demoPlans, month) : await ledgerApi.monthlyPlan(month, idToken);
    if (signal.aborted) return;
    const receipt = record.payslips?.find(item => item.uuid === id);
    if (!receipt) throw new Error("No pudimos encontrar el recibo.");
    setActivePayslip(receipt);
  };
  const access = { idToken, demoMode };
  const saveMonthlyReceived = async (amountMinor: number, revision: number) => {
    const key = monthDashboardQueryKey(selectedMonth);
    let monthlyReceived: NonNullable<MonthDashboard["monthlyReceived"]>;
    if (demoMode) {
      monthlyReceived = { id: "demo-monthly-received", month: selectedMonth, amountMinor,
        revision: revision + 1, updatedAt: now.toISOString() };
    } else {
      try {
        const { operationId } = await ledgerApi.previewMonthlyReceived(selectedMonth, amountMinor, revision, idToken);
        try {
          ({ monthlyReceived } = await ledgerApi.applyMonthlyReceived(operationId, idToken));
        } catch (error) {
          const status = await ledgerApi.financialWriteStatus(operationId, idToken).catch(() => undefined);
          if (status?.status !== "applied") throw error;
          ({ monthlyReceived } = await ledgerApi.applyMonthlyReceived(operationId, idToken));
        }
      } catch (error) {
        void queryClient.invalidateQueries({ queryKey: key, exact: true });
        throw error;
      }
    }
    queryClient.setQueryData<MonthDashboard>(key, previous => previous && { ...previous, monthlyReceived });
    if (!demoMode) void queryClient.invalidateQueries({ queryKey: key, exact: true });
  };

  const savePlan = async (nextPlan: MonthlyPlan) => {
    const saved = demoMode
      ? nextPlan
      : await ledgerApi.saveMonthlyPlan(selectedMonth, nextPlan, idToken);
    queryClient.setQueryData(monthlyPlanQueryKey(selectedMonth), saved);
    await queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot });
    if (!demoMode) await queryClient.invalidateQueries({ queryKey: monthlyPlanQueryRoot });
    await queryClient.invalidateQueries({ queryKey: commitmentsQueryRoot });
    await queryClient.invalidateQueries({ queryKey: budgetQueryRoot });
  };

  const openAnalyticsMovements = (label: string, eventIds: readonly string[], month = selectedMonth) => {
    if (month !== selectedMonth) setSelectedMonth(month);
    setMovementEvidenceFilter({ label, eventIds });
    setAnalyticsOpen(false);
    setTab("movements");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const goalsFetching = useIsFetching({ queryKey: financialGoalsQueryRoot }) > 0;
  const activeQueryFetching = tab === "wealth" ? wealthQuery.isFetching
    : tab === "planning" ? monthlyPlanQuery.isFetching || monthlySummaryQuery.isFetching || cardsQuery.isFetching || goalsFetching
    : tab === "movements" ? eventsQuery.isFetching || exceptionsQuery.isFetching
    : dashboardQuery.isFetching || monthlyPlanQuery.isFetching || monthlySummaryQuery.isFetching || analyticsQuery.isFetching;
  const summaryLoadError = monthlySummaryQuery.error instanceof Error
    ? monthlySummaryQuery.error.message
    : monthlySummaryQuery.error ? "No se pudo cargar el resumen del mes." : undefined;

  return (
    <>
      <AppShell
        tab={tab}
        onTabChange={setTab}
        month={selectedMonth}
        onMonthChange={(month) => {
          setSelectedMonth(month);
          setMovementEvidenceFilter(undefined);
        }}
        syncing={activeQueryFetching}
        refreshing={activeQueryFetching}
        onRefresh={refresh}
        privateMode={privateMode}
        onTogglePrivateMode={togglePrivateMode}
        onOpenPreferences={() => setPreferencesOpen(true)}
        demoMode={demoMode}
        error={tab === "movements" ? error : undefined}
      >
        {tab === "summary" && analyticsOpen ? (
          <AnalyticsView
            analytics={analyticsQuery.data}
            spending={dashboard?.spending}
            isCurrentMonth={isCurrentMonth}
            isFutureMonth={summary?.isFutureMonth ?? false}
            loading={analyticsQuery.isPending}
            loadError={analyticsQuery.error instanceof Error
              ? analyticsQuery.error.message
              : analyticsQuery.error ? "No se pudo cargar el análisis." : undefined}
            onRetry={() => {
              void analyticsQuery.refetch();
            }}
            onBack={() => setAnalyticsOpen(false)}
            onDrillDown={openAnalyticsMovements}
          />
        ) : tab === "summary" ? (
          <SummaryView
            month={selectedMonth}
            dashboard={dashboard}
            receivedEditor={saveMonthlyReceived}
            dashboardLoading={dashboardQuery.isPending}
            dashboardError={dashboardQuery.isError}
            privateMode={privateMode}
            onOpenBudget={() => setPlanningPane("budget")}
            onRetryDashboard={() => { void dashboardQuery.refetch(); }}
            spendAvailable={summary !== undefined && (dashboard !== undefined || !monthlySummaryQuery.isError)}
            spentMinor={spentMinor}
            uncertainMinor={uncertainMinor}
            analytics={analyticsQuery.data}
            analyticsLoading={analyticsQuery.isPending}
            analyticsLoadError={analyticsQuery.error instanceof Error
              ? analyticsQuery.error.message
              : analyticsQuery.error ? "No se pudo cargar el análisis." : undefined}
            onRetryAnalytics={() => {
              void analyticsQuery.refetch();
            }}
            onOpenAnalytics={() => {
              setAnalyticsOpen(true);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            onOpenAnalyticsMovements={openAnalyticsMovements}
          />
        ) : tab === "planning" ? (
          <PlanningView
            financialPlanning={<PlanningEntries month={selectedMonth} access={access} onOpen={setPlanningPane} onOpenEvent={openMsiEvent} />}
            month={selectedMonth}
            now={now}
            monthMsiRows={monthMsiRows}
            msiSpentMinor={msiSpentMinor}
            msiCommittedMinor={msiCommittedMinor}
            msiLoading={monthlySummaryQuery.isPending}
            msiLoadError={summaryLoadError}
            onRetryMsi={() => { void monthlySummaryQuery.refetch(); }}
            onOpenMsiEvent={openMsiEvent}
            fixedPayments={plan.upcomingPayments}
            inheritedFromMonth={plan.inheritedFromMonth}
            fixedPaymentsLoading={planLoading}
            fixedPaymentsLoadError={planLoadError}
            onRetryFixedPayments={() => { void monthlyPlanQuery.refetch(); }}
            billUpcomingMinor={summary && !summaryLoadError ? summary.billScheduledMinor : undefined}
            onAddPayment={() => demoMode ? setEditingPayment(null) : setFixedExpenseEditor({ month: selectedMonth < currentMonth ? currentMonth : selectedMonth })}
            onEditPayment={setEditingPayment}
            cards={cards}
            cardsLoading={cardsLoading}
            cardsLoadError={cardsLoadError}
            onRetryCards={() => { void cardsQuery.refetch(); }}
            onAddCard={() => setEditingCard(null)}
            onEditCard={setEditingCard}
            onOpenCommitments={() => setCommitmentsOpen(true)}
            onOpenStatements={() => setStatementsOpen(true)}
          />
        ) : tab === "wealth" ? (
          <WealthView
            overview={
              wealth ?? withWealthTotals({
                accounts: WEALTH_ACCOUNTS.map((account) => ({
                  ...account,
                  connected: false,
                  latestSnapshot: null,
                })),
                liabilities: [],
                history: { all: [], byAccount: {} },
              })
            }
            loading={wealthLoading && !wealth}
            loadError={wealthLoadError}
            onRetry={() => {
              void wealthQuery.refetch();
            }}
            selectedAccountId={selectedWealthAccount}
            onSelectAccount={setSelectedWealthAccount}
            onRegisterCash={setCashAccount}
            onClosePayroll={() => setPayrollCloseOpen(true)}
            onRegisterLiability={(liability) => setLiabilityCard(liability)}
            onSyncRemote={() => {
              bitsoSyncMutation.reset();
              ibkrSyncMutation.reset();
              bitsoSyncMutation.mutate();
              ibkrSyncMutation.mutate();
            }}
            syncingRemote={bitsoSyncMutation.isPending || ibkrSyncMutation.isPending}
            onSyncBitso={() => {
              bitsoSyncMutation.reset();
              bitsoSyncMutation.mutate();
            }}
            syncingBitso={bitsoSyncMutation.isPending}
            bitsoSyncError={
              bitsoSyncMutation.error instanceof Error
                ? bitsoSyncMutation.error.message
                : bitsoSyncMutation.error
                  ? "No se pudo sincronizar Bitso."
                  : undefined
            }
            onSyncIbkr={() => {
              ibkrSyncMutation.reset();
              ibkrSyncMutation.mutate();
            }}
            syncingIbkr={ibkrSyncMutation.isPending}
            ibkrSyncError={
              ibkrSyncMutation.error instanceof Error
                ? ibkrSyncMutation.error.message
                : ibkrSyncMutation.error
                  ? "No se pudo sincronizar IBKR."
                  : undefined
            }
            now={now}
          />
        ) : (
          <MovementsView
            events={summaryEvents}
            month={selectedMonth}
            spentMinor={spentMinor}
            loading={loading}
            sort={movementSort}
            onSortChange={setMovementSort}
            onOpen={setActiveEvent}
            exceptions={exceptions}
            onRetryException={retryException}
            onDiscardException={discardException}
            onReadExceptionRaw={readExceptionRaw}
            onImport={() => setImportOpen(true)}
            onImportAmex={() => setAmexImportOpen(true)}
            onImportAmexActivity={() => setAmexActivityOpen(true)}
            onImportSantanderStatement={() => setSantanderStatementOpen(true)}
            onRegisterCharge={() => setManualOpen(true)}
            evidenceFilter={movementEvidenceFilter}
            onClearEvidenceFilter={() => setMovementEvidenceFilter(undefined)}
          />
        )}
      </AppShell>

      {uploadingNomina && (
        <NominaUploadSheet
          month={selectedMonth}
          demoMode={demoMode}
          onClose={() => setUploadingNomina(false)}
          onUpload={async (files) => {
            const response = await ledgerApi.uploadNominas(files, idToken);
            await queryClient.invalidateQueries({ queryKey: monthlyPlanQueryKey(selectedMonth) });
            await queryClient.invalidateQueries({ queryKey: monthlySummaryQueryKey(selectedMonth) });
            await queryClient.invalidateQueries({ queryKey: expectedIncomeQueryRoot });
            await queryClient.invalidateQueries({ queryKey: budgetQueryRoot });
            return response;
          }}
        />
      )}
      {preferencesOpen && <PlanningReadDialog title="Preferencias" onClose={() => setPreferencesOpen(false)} suspended={false}>
        <div className="plan-read-body"><PushPreference idToken={idToken} demoMode={demoMode} />
          <button className="text-button plan-action" type="button" onClick={demoMode ? () => window.location.assign("/") : onSignOut}>
            {demoMode ? "Salir del mock" : "Salir"}
          </button>
        </div>
      </PlanningReadDialog>}
      {planningPane && <FinancialPlanningDialog key={`${selectedMonth}:${planningPane}`}
        pane={planningPane} month={selectedMonth} access={access} suspended={Boolean(activePayslip || activeEvent || uploadingNomina)}
        onClose={() => setPlanningPane(undefined)} onOpenEvent={openMsiEvent} onOpenPayslip={openPlanningPayslip} onUploadNomina={() => setUploadingNomina(true)} />}
      {activePayslip && (
        <PayslipSheet payslip={activePayslip} onClose={() => setActivePayslip(undefined)} />
      )}
      {fixedExpenseEditor && <FixedExpenseSheet initialMonth={fixedExpenseEditor.month} initialId={fixedExpenseEditor.id} idToken={idToken}
        onClose={() => setFixedExpenseEditor(undefined)} onApplied={async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["fixed-expenses"] }),
            queryClient.invalidateQueries({ queryKey: monthlyPlanQueryRoot }),
            queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot }),
            queryClient.invalidateQueries({ queryKey: commitmentsQueryRoot }),
            queryClient.invalidateQueries({ queryKey: budgetQueryRoot }),
          ]);
          setFixedExpenseEditor(undefined);
        }} />}
      {editingPayment !== undefined && (
        <PaymentSheet
          key={`${selectedMonth}/${editingPayment?.id ?? "new"}`}
          month={selectedMonth}
          candidates={events}
          candidatesLoading={loading}
          candidatesError={error}
          onRetryCandidates={() => { void eventsQuery.refetch(); }}
          onOpenEvent={openMsiEvent}
          onReconcile={editingPayment ? async (eventId) => {
            const paymentContext = editingPayment;
            const expectedEventId = paymentContext.reconciliation?.eventId ?? null;
            const saved = demoMode
              ? reconcileDemoPayment(plan, paymentContext.id, eventId, expectedEventId, paymentContext, events, selectedMonth)
              : await ledgerApi.reconcilePayment(selectedMonth, paymentContext.id, eventId, expectedEventId, paymentContext, idToken);
            queryClient.setQueryData(monthlyPlanQueryKey(selectedMonth), saved);
            await queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot });
            await queryClient.invalidateQueries({ queryKey: commitmentsQueryRoot });
            await queryClient.invalidateQueries({ queryKey: budgetQueryRoot });
            setEditingPayment(current => current === paymentContext ? saved.upcomingPayments.find(p => p.id === paymentContext.id) : current);
          } : undefined}
          payment={editingPayment ?? undefined}
          onConfigure={!demoMode && editingPayment ? () => {
            setFixedExpenseEditor({ month: selectedMonth < currentMonth ? currentMonth : selectedMonth, id: editingPayment.id });
            setEditingPayment(undefined);
          } : undefined}
          onClose={() => setEditingPayment(undefined)}
          onSave={async (payment) => {
            const existing = plan.upcomingPayments.filter((item) => item.id !== payment.id);
            await savePlan({
              ...plan,
              upcomingPayments: [...existing, payment].sort((a, b) => a.dueDay - b.dueDay),
            });
            setEditingPayment(undefined);
          }}
          onDelete={
            editingPayment
              ? async () => {
                  await savePlan({
                    ...plan,
                    upcomingPayments: plan.upcomingPayments.filter(
                      (item) => item.id !== editingPayment.id,
                    ),
                  });
                  setEditingPayment(undefined);
                }
              : undefined
          }
        />
      )}
      {editingCard !== undefined && (
        <CardSheet
          card={editingCard ?? undefined}
          onClose={() => setEditingCard(undefined)}
          onSave={async (card) => {
            const saved = demoMode ? card : await ledgerApi.saveCard(card, idToken);
            queryClient.setQueryData<{ cards: readonly CardCycle[] }>(cardsQueryKey, (current) => {
              const existing = (current?.cards ?? cards).filter((item) => item.id !== saved.id);
              return {
                cards: [...existing, saved].sort(
                  (left, right) =>
                    left.name.localeCompare(right.name, "es") || left.id.localeCompare(right.id),
                ),
              };
            });
            setEditingCard(undefined);
          }}
          onDelete={
            editingCard
              ? async () => {
                  if (!demoMode) await ledgerApi.deleteCard(editingCard.id, idToken);
                  queryClient.setQueryData<{ cards: readonly CardCycle[] }>(cardsQueryKey, (current) => ({
                    cards: (current?.cards ?? cards).filter((item) => item.id !== editingCard.id),
                  }));
                  setEditingCard(undefined);
                }
              : undefined
          }
        />
      )}
      {commitmentsOpen && (
        <CommitmentsSheet idToken={idToken} demoMode={demoMode} now={now}
          onClose={() => setCommitmentsOpen(false)}
          onOpenEvent={async (id) => {
            const event = demoMode ? mockEvents.find(event => event.id===id) : await ledgerApi.event(id, idToken);
            if (!event) throw new Error("Compra no disponible.");
            setCommitmentsOpen(false);
            setActiveEvent(event);
          }}
        />
      )}
      {importOpen && (
        <SantanderImportSheet
          idToken={idToken}
          onClose={() => setImportOpen(false)}
          onApplied={() => {
            setImportOpen(false);
            void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
            void queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot });
            refreshPlanningEvidence();
            void queryClient.invalidateQueries({ queryKey: monthlyPlanQueryRoot });
            void queryClient.invalidateQueries({ queryKey: analyticsQueryRoot });
            void queryClient.invalidateQueries({ queryKey: commitmentsQueryRoot });
          }}
        />
      )}
      {statementsOpen && (
        <StatementsSheet idToken={idToken} demoMode={demoMode} now={now} onClose={() => setStatementsOpen(false)}
          onImport={(provider, importId) => {
            setStatementsOpen(false);
            setReturnToStatements(true);
            setResumeStatementId(importId);
            if (provider === "amex") setAmexImportOpen(true);
            else setSantanderStatementOpen(true);
          }} />
      )}
      {amexActivityOpen && <AmexActivitySheet idToken={idToken} onClose={() => setAmexActivityOpen(false)} onApplied={() => {
        setAmexActivityOpen(false);
        void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
        void queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot });
        refreshPlanningEvidence();
        void queryClient.invalidateQueries({ queryKey: analyticsQueryRoot });
        void queryClient.invalidateQueries({ queryKey: commitmentsQueryRoot });
      }} />}
      {amexImportOpen && (
        <StatementImportSheet
          provider="amex"
          idToken={idToken}
          initialImportId={resumeStatementId}
          onOpenEvent={openMsiEvent}
          onClose={closeStatementImport}
          onApplied={() => {
            closeStatementImport();
            void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
            void queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot });
            refreshPlanningEvidence();
            void queryClient.invalidateQueries({ queryKey: monthlyPlanQueryRoot });
            void queryClient.invalidateQueries({ queryKey: analyticsQueryRoot });
            void queryClient.invalidateQueries({ queryKey: commitmentsQueryRoot });
          }}
        />
      )}
      {santanderStatementOpen && (
        <StatementImportSheet
          provider="santander"
          idToken={idToken}
          initialImportId={resumeStatementId}
          onOpenEvent={openMsiEvent}
          onClose={closeStatementImport}
          onApplied={() => {
            closeStatementImport();
            void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
            void queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot });
            refreshPlanningEvidence();
            void queryClient.invalidateQueries({ queryKey: monthlyPlanQueryRoot });
            void queryClient.invalidateQueries({ queryKey: analyticsQueryRoot });
            void queryClient.invalidateQueries({ queryKey: commitmentsQueryRoot });
          }}
        />
      )}
      {manualOpen && (
        <ManualEntrySheet
          idToken={idToken}
          demoMode={demoMode}
          now={now}
          onClose={() => setManualOpen(false)}
          onCredit={() => { setManualOpen(false); void dashboardQuery.refetch(); setTab("summary"); }}
          onCreated={(created) => {
            setManualOpen(false);
            const createdMonth = monthKey(eventDate(created));
            queryClient.setQueryData<EventFeed>(eventsQueryKey(createdMonth), (current) => ({
              events: [created, ...(current?.events ?? []).filter(event => event.id !== created.id)],
              msiRelated: current?.msiRelated ?? [],
            }));
            void queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot });
            if (!demoMode) void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
            refreshPlanningEvidence();
            void queryClient.invalidateQueries({ queryKey: monthlyPlanQueryRoot });
            void queryClient.invalidateQueries({ queryKey: analyticsQueryRoot });
            void queryClient.invalidateQueries({ queryKey: commitmentsQueryRoot });
            setActiveEvent(created);
            setTab("movements");
          }}
        />
      )}

      {liabilityCard && (
        <CardLiabilitySheet
          cardName={liabilityCard.name}
          currentMinor={liabilityCard.latestSnapshot?.totalMxnMinor}
          onClose={() => setLiabilityCard(undefined)}
          onSave={async (amountMinor) => {
            if (demoMode) {
              const day = dayKeyInZone(now);
              const snapshot = {
                cardId: liabilityCard.cardId,
                day,
                capturedAt: now.toISOString(),
                source: "manual" as const,
                currency: "MXN" as const,
                totalMxnMinor: amountMinor,
              };
              queryClient.setQueryData<WealthOverview>(wealthQueryKey, (current) => {
                const base: WealthOverview = current ?? demoWealthOverview;
                const liabilities = base.liabilities.map((liability) =>
                  liability.cardId === liabilityCard.cardId
                    ? { ...liability, latestSnapshot: snapshot }
                    : liability,
                );
                return withWealthTotals({
                  accounts: base.accounts,
                  liabilities,
                  history: base.history,
                });
              });
            } else {
              await ledgerApi.createCardLiabilitySnapshot(liabilityCard.cardId, amountMinor, idToken);
              await queryClient.invalidateQueries({ queryKey: wealthQueryKey });
            }
            setLiabilityCard(undefined);
            setTab("wealth");
          }}
        />
      )}
      {cashAccount && (
        <CashBalanceSheet
          accountName={WEALTH_ACCOUNTS.find(account => account.id === cashAccount)!.name}
          allowsZero={cashAccount === SANTANDER_CASH_ACCOUNT_ID}
          currentMinor={
            wealth?.accounts.find((account) => account.id === cashAccount)?.latestSnapshot
              ?.totalMxnMinor
          }
          onClose={() => setCashAccount(undefined)}
          onSave={async (amountMinor) => {
            if (demoMode) {
              const day = dayKeyInZone(now);
              const snapshot = {
                accountId: cashAccount,
                day,
                capturedAt: now.toISOString(),
                source: "manual" as const,
                currency: "MXN" as const,
                totalMxnMinor: amountMinor,
                holdings: [manualCashHolding(cashAccount, amountMinor)],
              };
              queryClient.setQueryData<WealthOverview>(wealthQueryKey, (current) => {
                const base: WealthOverview = current ?? demoWealthOverview;
                const accounts: WealthAccountView[] = base.accounts.map((account: WealthAccountView) =>
                  account.id === cashAccount
                    ? { ...account, connected: true, latestSnapshot: snapshot }
                    : account,
                );
                const previous: readonly WealthHistoryPoint[] =
                  base.history.byAccount[cashAccount] ?? [];
                const cashHistory: WealthHistoryPoint[] = [
                  ...previous.filter((point: WealthHistoryPoint) => point.day !== day),
                  { day, totalMxnMinor: amountMinor },
                ].sort((left, right) => left.day.localeCompare(right.day));
                const updated = withWealthTotals({
                  accounts,
                  liabilities: base.liabilities,
                  history: {
                    all: base.history.all,
                    byAccount: {
                      ...base.history.byAccount,
                      [cashAccount]: cashHistory,
                    },
                  },
                });
                return { ...updated, history: { ...updated.history, all: [
                  ...base.history.all.filter(point => point.day.slice(0, 7) !== day.slice(0, 7)),
                  { day: `${day.slice(0, 7)}-01`, totalMxnMinor: updated.netMxnMinor },
                ] } };
              });
            } else {
              await ledgerApi.createCashSnapshot(cashAccount, amountMinor, idToken);
              await queryClient.invalidateQueries({ queryKey: wealthQueryKey });
            }
            setCashAccount(undefined);
            setSelectedWealthAccount(cashAccount);
            setTab("wealth");
          }}
        />
      )}
      {payrollCloseOpen && wealth?.payrollCloseCandidate && (
        <PayrollClosureSheet
          candidate={wealth.payrollCloseCandidate}
          today={dayKeyInZone(now)}
          onClose={() => setPayrollCloseOpen(false)}
          onSave={async input => {
            await ledgerApi.closePayroll(input, idToken);
            setPayrollCloseOpen(false);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: wealthQueryKey }),
              queryClient.invalidateQueries({ queryKey: monthlyPlanQueryRoot }),
              queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot }),
              queryClient.invalidateQueries({ queryKey: expectedIncomeQueryRoot }),
            ]);
          }}
        />
      )}
      {activeEvent && (
        <EventSheet
          key={activeEvent.id}
          event={activeEvent}
          idToken={idToken}
          demoMode={demoMode}
          onClose={() => setActiveEvent(undefined)}
          onVerified={(event) => {
            void queryClient.invalidateQueries({ queryKey: budgetQueryRoot });
            const paymentContext = editingPayment;
            setActiveEvent(event);
            void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
            void queryClient.invalidateQueries({ queryKey: monthlySummaryQueryRoot });
            refreshPlanningEvidence();
            void queryClient.invalidateQueries({ queryKey: monthlyPlanQueryRoot }).then(() => {
              const refreshed = queryClient.getQueryData<MonthlyPlan>(monthlyPlanQueryKey(selectedMonth));
              if (refreshed) setEditingPayment(current => current && current === paymentContext
                ? refreshed.upcomingPayments.find(payment => payment.id === current.id) : current);
            });
            void queryClient.invalidateQueries({ queryKey: analyticsQueryRoot });
            void queryClient.invalidateQueries({ queryKey: commitmentsQueryRoot });
          }}
        />
      )}
    </>
  );
}
