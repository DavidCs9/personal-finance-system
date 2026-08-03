import { useEffect, useState } from "react";

const STORAGE_KEY = "olbia-private-mode";

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStored(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore quota / private browsing */
  }
}

/** Screen privacy: blur monetary amounts for demos. Persists in localStorage. */
export function usePrivateMode() {
  const [enabled, setEnabled] = useState(() => {
    const stored = readStored();
    document.documentElement.classList.toggle("private-mode", stored);
    return stored;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("private-mode", enabled);
    writeStored(enabled);
  }, [enabled]);

  return {
    privateMode: enabled,
    togglePrivateMode: () => setEnabled((current) => !current),
  } as const;
}
