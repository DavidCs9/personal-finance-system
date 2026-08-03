import type { ReactNode } from "react";

/** Marks a monetary (or numeric financial) value for private-mode blur. */
export function Amt({ children }: { children: ReactNode }) {
  return <span className="amt">{children}</span>;
}
