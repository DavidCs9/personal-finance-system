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
  showSignOut: boolean;
  onSignOut(): void;
  error?: string;
  children: ReactNode;
}) {
  return (
    <main className="app-shell">
      <Topbar
        syncing={syncing}
        refreshing={refreshing}
        onRefresh={onRefresh}
        showSignOut={showSignOut}
        onSignOut={onSignOut}
      />

      <div className={`app-content${tab === "summary" ? " summary-active" : " movements-active"}`}>
        {error && <p className="banner-error">{error}</p>}
        <TabNav tab={tab} onTabChange={onTabChange} variant="desktop" />
        <MonthSelector value={month} onChange={onMonthChange} />
        {children}
        <TabNav tab={tab} onTabChange={onTabChange} variant="mobile" />
      </div>
    </main>
  );
}
