import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { computeMonthSummary } from "@finance/domain";
import { ledgerApi } from "../api/client";
import { mockEventFeed } from "../api/mock-data";
import { AppShell } from "../layout/AppShell";
import { eventDate, monthKey } from "../lib/format";
import { eventsQueryKey, eventsQueryRoot, exceptionsQueryKey, monthlyPlanQueryKey } from "../lib/query-keys";
import type { Tab } from "../lib/tabs";
import {
  demoPlans,
  planFor,
  type MonthlyPlan,
  type PlannedPayment,
} from "../monthly-plan";
import { EventSheet } from "../sheets/EventSheet";
import { IncomeSheet } from "../sheets/IncomeSheet";
import { ManualEntrySheet } from "../sheets/ManualEntrySheet";
import { PaymentSheet } from "../sheets/PaymentSheet";
import { SantanderImportSheet } from "../sheets/SantanderImportSheet";
import { StatementImportSheet } from "../sheets/StatementImportSheet";
import type { EventFeed, IngestionException, PurchaseEvent } from "../types";
import { MovementsView } from "../views/MovementsView";
import { SummaryView } from "../views/SummaryView";

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
  const [selectedMonth, setSelectedMonth] = useState(monthKey(now));
  const [editingIncome, setEditingIncome] = useState(false);
  const [editingPayment, setEditingPayment] = useState<PlannedPayment | null | undefined>();
  const [activeEvent, setActiveEvent] = useState<PurchaseEvent>();
  const [movementSort, setMovementSort] = useState<"recent" | "largest">("recent");
  const [importOpen, setImportOpen] = useState(false);
  const [amexImportOpen, setAmexImportOpen] = useState(false);
  const [santanderStatementOpen, setSantanderStatementOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  const eventsQuery = useQuery({
    queryKey: eventsQueryKey(selectedMonth),
    queryFn: () =>
      demoMode ? Promise.resolve(mockEventFeed) : ledgerApi.listEvents(idToken, selectedMonth),
  });
  const exceptionsQuery = useQuery({
    queryKey: exceptionsQueryKey,
    queryFn: () =>
      demoMode
        ? Promise.resolve({ exceptions: [] as readonly IngestionException[] })
        : ledgerApi.listExceptions(idToken),
  });
  const monthlyPlanQuery = useQuery({
    queryKey: monthlyPlanQueryKey(selectedMonth),
    queryFn: () =>
      demoMode
        ? Promise.resolve(planFor(demoPlans, selectedMonth))
        : ledgerApi.monthlyPlan(selectedMonth, idToken),
  });

  const events = eventsQuery.data?.events ?? [];
  const msiRelated = eventsQuery.data?.msiRelated ?? [];
  const exceptions = exceptionsQuery.data?.exceptions ?? [];
  const plan = monthlyPlanQuery.data ?? planFor({}, selectedMonth);
  const loading = eventsQuery.isPending || eventsQuery.isFetching;
  const error =
    eventsQuery.error instanceof Error
      ? eventsQuery.error.message
      : eventsQuery.error
        ? "No se pudieron cargar los movimientos."
        : undefined;
  const planLoading = monthlyPlanQuery.isPending || monthlyPlanQuery.isFetching;
  const planLoadError =
    monthlyPlanQuery.error instanceof Error
      ? monthlyPlanQuery.error.message
      : monthlyPlanQuery.error
        ? "No se pudo cargar la configuración del mes."
        : undefined;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
    void queryClient.invalidateQueries({ queryKey: exceptionsQueryKey });
    void queryClient.invalidateQueries({ queryKey: monthlyPlanQueryKey(selectedMonth) });
  };

  const retryExceptionMutation = useMutation({
    mutationFn: (exceptionId: string) => ledgerApi.retryException(exceptionId, idToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: exceptionsQueryKey }),
  });
  const retryException = async (exceptionId: string) => {
    await retryExceptionMutation.mutateAsync(exceptionId);
  };
  const discardExceptionMutation = useMutation({
    mutationFn: (exceptionId: string) => ledgerApi.discardException(exceptionId, idToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: exceptionsQueryKey }),
  });
  const discardException = async (exceptionId: string) => {
    await discardExceptionMutation.mutateAsync(exceptionId);
  };
  const readExceptionRaw = (exceptionId: string) => ledgerApi.rawException(exceptionId, idToken);

  const monthEvents = events;
  const summaryEvents = useMemo(
    () => [...events, ...msiRelated],
    [events, msiRelated],
  );
  const summary = useMemo(
    () =>
      computeMonthSummary({
        events: summaryEvents.map((event) => ({
          id: event.id,
          amountMinor: event.amount.amountMinor,
          status: event.status,
          occurredAt: event.occurredAt,
          receivedAt: event.receivedAt,
          merchantRaw: event.merchantRaw,
          msi: event.msi,
        })),
        month: selectedMonth,
        incomeMinor: plan.incomeMinor,
        incomeConfigured: plan.configured,
        upcomingPaymentsMinor: plan.upcomingPayments.reduce(
          (sum, payment) => sum + payment.amountMinor,
          0,
        ),
        now,
      }),
    [summaryEvents, selectedMonth, plan.incomeMinor, plan.configured, plan.upcomingPayments, now],
  );
  const {
    spentMinor,
    uncertainMinor,
    billUpcomingMinor,
    remainingMinor,
    projectedRemainingMinor,
    isCurrentMonth,
    msiSpentMinor,
    msiCommittedMinor,
    monthMsiRows,
  } = summary;

  const openMsiEvent = (eventId: string) => {
    const found = summaryEvents.find((event) => event.id === eventId);
    if (found) setActiveEvent(found);
  };
  const spendPercent = plan.incomeMinor > 0 ? Math.round((spentMinor / plan.incomeMinor) * 100) : 0;
  const risk =
    plan.incomeMinor > 0 && projectedRemainingMinor < 0
      ? "danger"
      : spendPercent >= 70
        ? "watch"
        : "steady";

  const savePlan = async (nextPlan: MonthlyPlan) => {
    const saved = demoMode
      ? nextPlan
      : await ledgerApi.saveMonthlyPlan(selectedMonth, nextPlan, idToken);
    queryClient.setQueryData(monthlyPlanQueryKey(selectedMonth), saved);
    await queryClient.invalidateQueries({ queryKey: monthlyPlanQueryKey(selectedMonth) });
  };

  const reviewLargest = () => {
    setMovementSort("largest");
    setTab("movements");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <>
      <AppShell
        tab={tab}
        onTabChange={setTab}
        month={selectedMonth}
        onMonthChange={setSelectedMonth}
        syncing={loading}
        refreshing={loading || planLoading}
        onRefresh={refresh}
        showSignOut={!demoMode}
        onSignOut={onSignOut}
        error={error}
      >
        {tab === "summary" ? (
          <SummaryView
            month={selectedMonth}
            plan={plan}
            loading={planLoading}
            loadError={planLoadError}
            onRetry={() => {
              void monthlyPlanQuery.refetch();
            }}
            spentMinor={spentMinor}
            uncertainMinor={uncertainMinor}
            billUpcomingMinor={billUpcomingMinor}
            remainingMinor={remainingMinor}
            projectedRemainingMinor={projectedRemainingMinor}
            spendPercent={spendPercent}
            isCurrentMonth={isCurrentMonth}
            risk={risk}
            monthMsiRows={monthMsiRows}
            msiSpentMinor={msiSpentMinor}
            msiCommittedMinor={msiCommittedMinor}
            onEditIncome={() => setEditingIncome(true)}
            onAddPayment={() => setEditingPayment(null)}
            onEditPayment={(payment) => setEditingPayment(payment)}
            onOpenMsiEvent={openMsiEvent}
            onReviewLargest={reviewLargest}
            idToken={idToken}
            demoMode={demoMode}
          />
        ) : (
          <MovementsView
            events={monthEvents}
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
            onImportSantanderStatement={() => setSantanderStatementOpen(true)}
            onRegisterCharge={() => setManualOpen(true)}
          />
        )}
      </AppShell>

      {editingIncome && (
        <IncomeSheet
          month={selectedMonth}
          incomeMinor={plan.incomeMinor}
          onClose={() => setEditingIncome(false)}
          onSave={async (incomeMinor) => {
            await savePlan({ ...plan, month: selectedMonth, configured: true, incomeMinor });
            setEditingIncome(false);
          }}
        />
      )}
      {editingPayment !== undefined && (
        <PaymentSheet
          payment={editingPayment ?? undefined}
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
      {activeEvent && (
        <EventSheet
          key={activeEvent.id}
          event={activeEvent}
          idToken={idToken}
          demoMode={demoMode}
          onClose={() => setActiveEvent(undefined)}
          onVerified={setActiveEvent}
        />
      )}
      {importOpen && (
        <SantanderImportSheet
          idToken={idToken}
          onClose={() => setImportOpen(false)}
          onApplied={() => {
            setImportOpen(false);
            void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
          }}
        />
      )}
      {amexImportOpen && (
        <StatementImportSheet
          provider="amex"
          idToken={idToken}
          onClose={() => setAmexImportOpen(false)}
          onApplied={() => {
            setAmexImportOpen(false);
            void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
          }}
        />
      )}
      {santanderStatementOpen && (
        <StatementImportSheet
          provider="santander"
          idToken={idToken}
          onClose={() => setSantanderStatementOpen(false)}
          onApplied={() => {
            setSantanderStatementOpen(false);
            void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
          }}
        />
      )}
      {manualOpen && (
        <ManualEntrySheet
          idToken={idToken}
          demoMode={demoMode}
          now={now}
          onClose={() => setManualOpen(false)}
          onCreated={(created) => {
            setManualOpen(false);
            const createdMonth = monthKey(eventDate(created));
            queryClient.setQueryData<EventFeed>(eventsQueryKey(createdMonth), (current) => ({
              events: [created, ...(current?.events ?? [])],
              msiRelated: current?.msiRelated ?? [],
            }));
            void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
            setActiveEvent(created);
            setTab("movements");
          }}
        />
      )}
    </>
  );
}
