import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ledgerApi, sessionExpiredEvent, type LedgerSession } from "./api/client";
import { LoadingScreen } from "./auth/LoadingScreen";
import { SignIn } from "./auth/SignIn";
import { Dashboard } from "./dashboard/Dashboard";

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
    const restoreWhenVisible = () => {
      if (document.visibilityState === "visible") restore(false);
    };
    const resume = () => restore(false);
    const expire = () => {
      if (!active) return;
      queryClient.clear();
      setIdToken(null);
    };

    restore(true);
    const interval = window.setInterval(resume, 5 * 60 * 1000);
    window.addEventListener("pageshow", resume);
    window.addEventListener(sessionExpiredEvent, expire);
    document.addEventListener("visibilitychange", restoreWhenVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener(sessionExpiredEvent, expire);
      document.removeEventListener("visibilitychange", restoreWhenVisible);
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
