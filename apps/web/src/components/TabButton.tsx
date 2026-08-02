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
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 7h14M5 12h14M5 17h9" />
        </svg>
      )}
      <span>{children}</span>
    </button>
  );
}
