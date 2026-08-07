import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { computeMonthSummary } from "@finance/domain";
import { ledgerApi } from "../api/client";
import { mockExceptionRawEmail, mockExceptions, mockFeedForMonth } from "../api/mock-data";
import { AppShell } from "../layout/AppShell";
import { eventDate, monthKey } from "../lib/format";
import { usePrivateMode } from "../lib/private-mode";
import { eventsQueryKey, eventsQueryRoot, exceptionsQueryKey, monthlyPlanQueryKey, cardsQueryKey, wealthQueryKey } from "../lib/query-keys";
import type { Tab } from "../lib/tabs";
import {
  demoPlans,
  planFor,
  type MonthlyPlan,
  type PlannedPayment,
} from "../monthly-plan";
import { demoCards } from "../card-cycle-demo";
import type { CardCycle } from "../card-cycle";
import { EventSheet } from "../sheets/EventSheet";
import { MonthIncomeSheet } from "../sheets/MonthIncomeSheet";
import { NominaUploadSheet } from "../sheets/NominaUploadSheet";
import { PayslipSheet } from "../sheets/PayslipSheet";
import type { Payslip } from "../monthly-plan";
import { CajitaSheet } from "../sheets/CajitaSheet";
import { ManualEntrySheet } from "../sheets/ManualEntrySheet";
import { PaymentSheet } from "../sheets/PaymentSheet";
import { CardSheet } from "../sheets/CardSheet";
import { SantanderImportSheet } from "../sheets/SantanderImportSheet";
import { StatementImportSheet } from "../sheets/StatementImportSheet";
import type { EventFeed, PurchaseEvent } from "../types";
import { MovementsView } from "../views/MovementsView";
import { SummaryView } from "../views/SummaryView";
import { WealthView } from "../views/WealthView";
import { demoWealthOverview } from "../wealth-demo";
import type { WealthOverview, WealthAccountView, WealthHistoryPoint } from "../wealth";
import { CAJITA_ACCOUNT_ID, BITSO_ACCOUNT_ID, IBKR_ACCOUNT_ID, WEALTH_ACCOUNTS, dayKeyInZone, type WealthAccountId, type WealthSnapshot } from "@finance/domain";

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
  const [incomeSheetOpen, setIncomeSheetOpen] = useState(false);
  const [activePayslip, setActivePayslip] = useState<Payslip>();
  const [uploadingNomina, setUploadingNomina] = useState(false);
  const [editingPayment, setEditingPayment] = useState<PlannedPayment | null | undefined>();
  const [editingCard, setEditingCard] = useState<CardCycle | null | undefined>();
  const [activeEvent, setActiveEvent] = useState<PurchaseEvent>();
  const [movementSort, setMovementSort] = useState<"recent" | "largest">("recent");
  const [importOpen, setImportOpen] = useState(false);
  const [amexImportOpen, setAmexImportOpen] = useState(false);
  const [santanderStatementOpen, setSantanderStatementOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [cajitaOpen, setCajitaOpen] = useState(false);
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
  const monthlyPlanQuery = useQuery({
    queryKey: monthlyPlanQueryKey(selectedMonth),
    queryFn: () =>
      demoMode
        ? Promise.resolve(planFor(demoPlans, selectedMonth))
        : ledgerApi.monthlyPlan(selectedMonth, idToken),
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

  const bitsoSyncMutation = useMutation({
    mutationFn: async () => {
      if (demoMode) {
        const day = dayKeyInZone(now);
        const snapshot: WealthSnapshot = {
          accountId: BITSO_ACCOUNT_ID,
          day,
          capturedAt: now.toISOString(),
          source: "api",
          currency: "MXN",
          totalMxnMinor: 1_250_000,
          fxSource: "bitso_ticker",
          holdings: demoWealthOverview.accounts.find((account) => account.id === BITSO_ACCOUNT_ID)
            ?.latestSnapshot?.holdings ?? [],
        };
        return { snapshot, skipped: [] as string[] };
      }
      return ledgerApi.syncBitso(idToken);
    },
    onSuccess: async (result) => {
      if (demoMode) {
        const snapshot = result.snapshot;
        queryClient.setQueryData<WealthOverview>(wealthQueryKey, (current) => {
          const base: WealthOverview = current ?? demoWealthOverview;
          const accounts: WealthAccountView[] = base.accounts.map((account: WealthAccountView) =>
            account.id === BITSO_ACCOUNT_ID
              ? { ...account, connected: true, latestSnapshot: snapshot }
              : account,
          );
          const previous: readonly WealthHistoryPoint[] = base.history.byAccount.bitso ?? [];
          const bitsoHistory: WealthHistoryPoint[] = [
            ...previous.filter((point) => point.day !== snapshot.day),
            { day: snapshot.day, totalMxnMinor: snapshot.totalMxnMinor },
          ].sort((left, right) => left.day.localeCompare(right.day));
          const allByDay = new Map<string, number>();
          for (const account of accounts) {
            for (const point of (
              account.id === BITSO_ACCOUNT_ID
                ? bitsoHistory
                : (base.history.byAccount[account.id] ?? [])
            )) {
              allByDay.set(point.day, (allByDay.get(point.day) ?? 0) + point.totalMxnMinor);
            }
          }
          return {
            currency: "MXN",
            totalMxnMinor: accounts.reduce(
              (sum, account) => sum + (account.latestSnapshot?.totalMxnMinor ?? 0),
              0,
            ),
            accounts,
            history: {
              all: [...allByDay.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([day, totalMxnMinor]) => ({ day, totalMxnMinor })),
              byAccount: {
                ...base.history.byAccount,
                bitso: bitsoHistory,
              },
            },
          };
        });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: wealthQueryKey });
    },
  });

  const ibkrSyncMutation = useMutation({
    mutationFn: async () => {
      if (demoMode) {
        const day = dayKeyInZone(now);
        const snapshot: WealthSnapshot = {
          accountId: IBKR_ACCOUNT_ID,
          day,
          capturedAt: now.toISOString(),
          source: "flex",
          currency: "MXN",
          totalMxnMinor: 12_500_500,
          fxRate: 20,
          fxSource: "banxico_sf43718",
          holdings: demoWealthOverview.accounts.find((account) => account.id === IBKR_ACCOUNT_ID)
            ?.latestSnapshot?.holdings ?? [],
        };
        return { snapshot, skipped: [] as string[], fxRate: 20 };
      }
      return ledgerApi.syncIbkr(idToken);
    },
    onSuccess: async (result) => {
      if (demoMode) {
        const snapshot = result.snapshot;
        queryClient.setQueryData<WealthOverview>(wealthQueryKey, (current) => {
          const base: WealthOverview = current ?? demoWealthOverview;
          const accounts: WealthAccountView[] = base.accounts.map((account: WealthAccountView) =>
            account.id === IBKR_ACCOUNT_ID
              ? { ...account, connected: true, latestSnapshot: snapshot }
              : account,
          );
          const previous: readonly WealthHistoryPoint[] = base.history.byAccount.ibkr ?? [];
          const ibkrHistory: WealthHistoryPoint[] = [
            ...previous.filter((point) => point.day !== snapshot.day),
            { day: snapshot.day, totalMxnMinor: snapshot.totalMxnMinor },
          ].sort((left, right) => left.day.localeCompare(right.day));
          const allByDay = new Map<string, number>();
          for (const account of accounts) {
            for (const point of (
              account.id === IBKR_ACCOUNT_ID
                ? ibkrHistory
                : (base.history.byAccount[account.id] ?? [])
            )) {
              allByDay.set(point.day, (allByDay.get(point.day) ?? 0) + point.totalMxnMinor);
            }
          }
          return {
            currency: "MXN",
            totalMxnMinor: accounts.reduce(
              (sum, account) => sum + (account.latestSnapshot?.totalMxnMinor ?? 0),
              0,
            ),
            accounts,
            history: {
              all: [...allByDay.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([day, totalMxnMinor]) => ({ day, totalMxnMinor })),
              byAccount: {
                ...base.history.byAccount,
                ibkr: ibkrHistory,
              },
            },
          };
        });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: wealthQueryKey });
    },
  });

  const events = eventsQuery.data?.events ?? [];
  const msiRelated = eventsQuery.data?.msiRelated ?? [];
  const exceptions = exceptionsQuery.data?.exceptions ?? [];
  const plan = monthlyPlanQuery.data ?? planFor({}, selectedMonth);
  const cards = cardsQuery.data?.cards ?? [];
  const wealth = wealthQuery.data;
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
  const cardsLoading = cardsQuery.isPending || cardsQuery.isFetching;
  const cardsLoadError =
    cardsQuery.error instanceof Error
      ? cardsQuery.error.message
      : cardsQuery.error
        ? "No se pudieron cargar tus tarjetas."
        : undefined;
  const wealthLoading = wealthQuery.isPending || wealthQuery.isFetching;
  const wealthLoadError =
    wealthQuery.error instanceof Error
      ? wealthQuery.error.message
      : wealthQuery.error
        ? "No se pudo cargar tu patrimonio."
        : undefined;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: eventsQueryRoot });
    void queryClient.invalidateQueries({ queryKey: exceptionsQueryKey });
    void queryClient.invalidateQueries({ queryKey: monthlyPlanQueryKey(selectedMonth) });
    void queryClient.invalidateQueries({ queryKey: cardsQueryKey });
    void queryClient.invalidateQueries({ queryKey: wealthQueryKey });
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
        syncing={tab === "wealth" ? wealthLoading : loading}
        refreshing={tab === "wealth" ? wealthLoading : loading || planLoading}
        onRefresh={refresh}
        privateMode={privateMode}
        onTogglePrivateMode={togglePrivateMode}
        demoMode={demoMode}
        showSignOut={!demoMode}
        onSignOut={
          demoMode
            ? () => {
                window.location.assign("/");
              }
            : onSignOut
        }
        error={tab === "wealth" ? undefined : error}
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
            onUploadNomina={() => setUploadingNomina(true)}
            onOpenIncome={() => setIncomeSheetOpen(true)}
            onOpenPayslip={setActivePayslip}
            onAddPayment={() => setEditingPayment(null)}
            onEditPayment={(payment) => setEditingPayment(payment)}
            onOpenMsiEvent={openMsiEvent}
            onReviewLargest={reviewLargest}
            cards={cards}
            cardsLoading={cardsLoading}
            cardsLoadError={cardsLoadError}
            onRetryCards={() => {
              void cardsQuery.refetch();
            }}
            onAddCard={() => setEditingCard(null)}
            onEditCard={(card) => setEditingCard(card)}
            now={now}
            idToken={idToken}
            demoMode={demoMode}
          />
        ) : tab === "wealth" ? (
          <WealthView
            overview={
              wealth ?? {
                currency: "MXN" as const,
                totalMxnMinor: 0,
                accounts: WEALTH_ACCOUNTS.map((account) => ({
                  ...account,
                  connected: false,
                  latestSnapshot: null,
                })),
                history: { all: [], byAccount: {} },
              }
            }
            loading={wealthLoading && !wealth}
            loadError={wealthLoadError}
            onRetry={() => {
              void wealthQuery.refetch();
            }}
            selectedAccountId={selectedWealthAccount}
            onSelectAccount={setSelectedWealthAccount}
            onRegisterCajita={() => setCajitaOpen(true)}
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

      {uploadingNomina && (
        <NominaUploadSheet
          month={selectedMonth}
          demoMode={demoMode}
          onClose={() => setUploadingNomina(false)}
          onUpload={async (files) => {
            const response = await ledgerApi.uploadNominas(files, idToken);
            await queryClient.invalidateQueries({ queryKey: monthlyPlanQueryKey(selectedMonth) });
            return response;
          }}
        />
      )}
      {incomeSheetOpen && (
        <MonthIncomeSheet
          plan={plan}
          onClose={() => setIncomeSheetOpen(false)}
          onOpenPayslip={(payslip) => setActivePayslip(payslip)}
          onUploadNomina={() => {
            setIncomeSheetOpen(false);
            setUploadingNomina(true);
          }}
        />
      )}
      {activePayslip && (
        <PayslipSheet payslip={activePayslip} onClose={() => setActivePayslip(undefined)} />
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
            await queryClient.invalidateQueries({ queryKey: cardsQueryKey });
            setEditingCard(undefined);
          }}
          onDelete={
            editingCard
              ? async () => {
                  if (!demoMode) await ledgerApi.deleteCard(editingCard.id, idToken);
                  queryClient.setQueryData<{ cards: readonly CardCycle[] }>(cardsQueryKey, (current) => ({
                    cards: (current?.cards ?? cards).filter((item) => item.id !== editingCard.id),
                  }));
                  await queryClient.invalidateQueries({ queryKey: cardsQueryKey });
                  setEditingCard(undefined);
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
      {cajitaOpen && (
        <CajitaSheet
          currentMinor={
            wealth?.accounts.find((account) => account.id === CAJITA_ACCOUNT_ID)?.latestSnapshot
              ?.totalMxnMinor
          }
          onClose={() => setCajitaOpen(false)}
          onSave={async (amountMinor) => {
            if (demoMode) {
              const day = dayKeyInZone(now);
              const snapshot = {
                accountId: CAJITA_ACCOUNT_ID,
                day,
                capturedAt: now.toISOString(),
                source: "manual" as const,
                currency: "MXN" as const,
                totalMxnMinor: amountMinor,
                holdings: [
                  {
                    id: "emergency_fund",
                    symbol: "MXN",
                    name: "Fondo de emergencia",
                    quantity: amountMinor / 100,
                    currency: "MXN",
                    valueNativeMinor: amountMinor,
                    valueMxnMinor: amountMinor,
                  },
                ],
              };
              queryClient.setQueryData<WealthOverview>(wealthQueryKey, (current) => {
                const base: WealthOverview = current ?? demoWealthOverview;
                const accounts: WealthAccountView[] = base.accounts.map((account: WealthAccountView) =>
                  account.id === CAJITA_ACCOUNT_ID
                    ? { ...account, connected: true, latestSnapshot: snapshot }
                    : account,
                );
                const previous: readonly WealthHistoryPoint[] =
                  base.history.byAccount.nu_cajita_emergencia ?? [];
                const cajitaHistory: WealthHistoryPoint[] = [
                  ...previous.filter((point: WealthHistoryPoint) => point.day !== day),
                  { day, totalMxnMinor: amountMinor },
                ].sort((left, right) => left.day.localeCompare(right.day));
                return {
                  currency: "MXN" as const,
                  totalMxnMinor: accounts.reduce(
                    (sum: number, account: WealthAccountView) =>
                      sum + (account.latestSnapshot?.totalMxnMinor ?? 0),
                    0,
                  ),
                  accounts,
                  history: {
                    all: cajitaHistory,
                    byAccount: {
                      ...base.history.byAccount,
                      nu_cajita_emergencia: cajitaHistory,
                    },
                  },
                };
              });
            } else {
              await ledgerApi.createCajitaSnapshot(amountMinor, idToken);
              await queryClient.invalidateQueries({ queryKey: wealthQueryKey });
            }
            setCajitaOpen(false);
            setSelectedWealthAccount(CAJITA_ACCOUNT_ID);
            setTab("wealth");
          }}
        />
      )}
    </>
  );
}
