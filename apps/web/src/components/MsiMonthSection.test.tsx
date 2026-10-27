import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MonthMsiRow } from "@finance/domain";
import { MsiMonthSection } from "./MsiMonthSection";

const purchase = (overrides: Partial<MonthMsiRow> = {}): MonthMsiRow => ({
  eventId: "amazon-first",
  name: "AMAZON A MESES · MSI 1/3",
  merchantRaw: "AMAZON A MESES",
  amountMinor: 367_97,
  principalMinor: 1_103_91,
  cuotaMinor: 367_97,
  installmentIndex: 1,
  months: 3,
  status: "spent",
  startMonth: "2026-10",
  endMonth: "2026-12",
  ...overrides,
});

const sameMerchant = [
  purchase(),
  purchase({ eventId: "amazon-second", amountMinor: 476_34, cuotaMinor: 476_34,
    principalMinor: 1_429_02, status: "committed" }),
];

describe("MSI purchase identity and financial presentation", () => {
  it("keeps same-merchant purchases separate, in input order, with their own amounts and detail actions", () => {
    const onOpen = vi.fn();
    const view = MsiMonthSection({ rows: sameMerchant, onOpen });
    const rows = findElements(view, element => element.props.className === "msi-purchase-row");
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.type)).toEqual(["button", "button"]);

    const first = renderToStaticMarkup(rows[0]!);
    const second = renderToStaticMarkup(rows[1]!);
    for (const html of [first, second]) {
      expect(html).toContain("AMAZON A MESES");
      expect(html).toContain("Cuota 1/3");
      expect(html).toContain("Cuota del mes");
      expect(html).toContain("Compra total");
      expect(html).toContain("Inicio oct 2026");
      expect(html).toContain("Fin dic 2026");
    }
    expect(first).toContain('<span class="amt">$368</span>');
    expect(first).toContain('<span class="amt">$1,104</span>');
    expect(second).toContain('<span class="amt">$476</span>');
    expect(second).toContain('<span class="amt">$1,429</span>');
    rows[0]!.props.onClick?.();
    rows[1]!.props.onClick?.();
    expect(onOpen.mock.calls).toEqual([["amazon-first"], ["amazon-second"]]);
  });

  it("preserves tags and reported installment amounts without claiming payment or reconciliation", () => {
    const rows = [purchase({ amountMinor: 350_00, tags: ["compra:dron", "work:setup"] }), sameMerchant[1]!];
    const html = renderToStaticMarkup(<MsiMonthSection rows={rows} onOpen={() => {}} />);
    expect(html).toContain('<span class="amt">$350</span>');
    expect(html).not.toContain('<span class="amt">$368</span>');
    expect(html).toContain('aria-label="Tags: compra:dron, work:setup"');
    expect(html).toContain("Registrada en gasto");
    expect(html).toContain("Comprometida este mes");
    expect(html).not.toMatch(/reconciliada|pagada|pagado/);
  });

  it("omits only the upper heading and total when embedded and retains the lower totals", () => {
    const totals = { msiSpentMinor: 367_97, msiCommittedMinor: 476_34, showTotals: true };
    const standalone = renderToStaticMarkup(<MsiMonthSection rows={sameMerchant} {...totals} onOpen={() => {}} />);
    const embedded = renderToStaticMarkup(<MsiMonthSection rows={sameMerchant} {...totals} embedded onOpen={() => {}} />);
    expect(standalone).toContain("Planes con fin");
    expect(standalone).toContain('class="section-total"');
    expect(embedded).not.toContain("Planes con fin");
    expect(embedded).not.toContain('class="section-total"');
    for (const html of [standalone, embedded]) {
      expect(html).toContain("AMAZON A MESES");
      expect(html).toContain('class="payment-total msi-totals"');
      expect(html).toContain('Registradas <span class="amt">$368</span>');
      expect(html).toContain('Comprometidas <span class="amt">$476</span>');
      expect(html).toContain('<span class="amt">$844</span>');
    }
  });

  it("keeps a purchase without an event ID readable without offering a false detail action", () => {
    const onOpen = vi.fn();
    const view = MsiMonthSection({ rows: [purchase({ eventId: undefined })], onOpen });
    const rows = findElements(view, element => element.props.className === "msi-purchase-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("div");
    expect(rows[0]!.props.onClick).toBeUndefined();
    const html = renderToStaticMarkup(view);
    expect(html).toContain("AMAZON A MESES");
    expect(html).toContain("Compra total");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('class="chevron"');
    expect(html).not.toContain("amazon-first");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("does not invent a section for an empty month or lower totals without complete inputs", () => {
    expect(MsiMonthSection({ rows: [], onOpen() {} })).toBeNull();
    for (const totals of [{}, { showTotals: true, msiSpentMinor: 367_97 }]) {
      const html = renderToStaticMarkup(<MsiMonthSection rows={sameMerchant} {...totals} onOpen={() => {}} />);
      expect(html).not.toContain('class="payment-total msi-totals"');
    }
  });
});

type ElementProps = { readonly children?: ReactNode; readonly className?: string; readonly onClick?: () => void };

const findElements = (
  node: ReactNode,
  predicate: (element: ReactElement<ElementProps>) => boolean,
): ReactElement<ElementProps>[] => Children.toArray(node).flatMap(child => {
  if (!isValidElement<ElementProps>(child)) return [];
  return [...(predicate(child) ? [child] : []), ...findElements(child.props.children, predicate)];
});
