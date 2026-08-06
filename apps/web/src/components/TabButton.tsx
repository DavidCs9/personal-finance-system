import type { ReactNode } from "react";
import type { Tab } from "../lib/tabs";

export function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick(): void;
  icon: Tab;
  children: ReactNode;
}) {
  return (
    <button className={active ? "active" : ""} onClick={onClick} role="tab" aria-selected={active}>
      {icon === "summary" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 19V9m8 10V5m8 14v-7" />
        </svg>
      ) : icon === "movements" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 7h14M5 12h14M5 17h9" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 10h16M7 10V8.5A2.5 2.5 0 0 1 9.5 6h5A2.5 2.5 0 0 1 17 8.5V10M6 10v8h12v-8" />
        </svg>
      )}
      <span>{children}</span>
    </button>
  );
}
