import type { ReactNode } from "react";
import { MonthSelector } from "../components/MonthSelector";
import type { Tab } from "../lib/tabs";
import { TabNav } from "./TabNav";
import { Topbar } from "./Topbar";

export function AppShell({
  tab,
  onTabChange,
  month,
  onMonthChange,
  syncing,
  refreshing,
  onRefresh,
  privateMode,
  onTogglePrivateMode,
  demoMode,
  showSignOut,
  onSignOut,
  error,
  children,
}: {
  tab: Tab;
  onTabChange(tab: Tab): void;
  month: string;
  onMonthChange(month: string): void;
  syncing: boolean;
  refreshing: boolean;
  onRefresh(): void;
  privateMode: boolean;
  onTogglePrivateMode(): void;
  demoMode: boolean;
  showSignOut: boolean;
  onSignOut(): void;
  error?: string;
  children: ReactNode;
}) {
  const contentClass =
    tab === "summary"
      ? "summary-active"
      : tab === "movements"
        ? "movements-active"
        : "wealth-active";

  return (
    <main className="app-shell">
      <Topbar
        syncing={syncing}
        refreshing={refreshing}
        onRefresh={onRefresh}
        privateMode={privateMode}
        onTogglePrivateMode={onTogglePrivateMode}
        demoMode={demoMode}
        showSignOut={showSignOut}
        onSignOut={onSignOut}
      />

      <div className={`app-content ${contentClass}`}>
        {error && <p className="banner-error">{error}</p>}
        <MonthSelector
          value={month}
          onChange={onMonthChange}
          disabled={tab === "wealth"}
        />
        <TabNav tab={tab} onTabChange={onTabChange} variant="desktop" />
        {children}
        <TabNav tab={tab} onTabChange={onTabChange} variant="mobile" />
      </div>
    </main>
  );
}
