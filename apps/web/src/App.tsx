import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ledgerApi, sessionExpiredEvent, type LedgerSession } from "./api/client";
import { LoadingScreen } from "./auth/LoadingScreen";
import { SignIn } from "./auth/SignIn";
import { Dashboard } from "./dashboard/Dashboard";
import { expectedIncomeQueryRoot, financialGoalsQueryRoot, monthlySummaryQueryRoot } from "./lib/query-keys";

export function App() {
  const queryClient = useQueryClient();
  const demoMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("demo") === "1";
  const [idToken, setIdToken] = useState<string | null | undefined>(demoMode ? "demo" : undefined);

  useEffect(() => {
    if (demoMode) return;
    let active = true;
    const restore = (fallbackToSignIn: boolean) => {
      void ledgerApi
        .restoreSession()
        .then((token) => {
          if (active) setIdToken(token ?? null);
        })
        .catch(() => {
          if (active && fallbackToSignIn) setIdToken(null);
        });
    };
    const refreshOnReturn = () => {
      if (document.visibilityState !== "visible") return;
      restore(false);
      // ChatGPT can change these records while the web app is in the background.
      for (const queryKey of [financialGoalsQueryRoot, monthlySummaryQueryRoot, expectedIncomeQueryRoot]) {
        void queryClient.refetchQueries({ queryKey, type: "active" }, { cancelRefetch: false });
      }
    };
    const expire = () => {
      if (!active) return;
      queryClient.clear();
      setIdToken(null);
    };

    restore(true);
    const interval = window.setInterval(() => restore(false), 5 * 60 * 1000);
    window.addEventListener("pageshow", refreshOnReturn);
    window.addEventListener("focus", refreshOnReturn);
    window.addEventListener(sessionExpiredEvent, expire);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("pageshow", refreshOnReturn);
      window.removeEventListener("focus", refreshOnReturn);
      window.removeEventListener(sessionExpiredEvent, expire);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [demoMode, queryClient]);

  const onSignedIn = (session: LedgerSession) => {
    queryClient.clear();
    ledgerApi.saveSession(session);
    setIdToken(session.idToken);
  };

  if (idToken === undefined) return <LoadingScreen />;
  if (!idToken) return <SignIn onSignedIn={onSignedIn} />;
  return (
    <Dashboard
      idToken={idToken}
      demoMode={demoMode}
      onSignOut={() => {
        queryClient.clear();
        ledgerApi.clearSession();
        setIdToken(null);
      }}
    />
  );
}
