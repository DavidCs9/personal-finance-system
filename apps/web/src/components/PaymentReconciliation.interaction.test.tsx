import { Children, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mockEvents } from "../api/mock-data";
import { PaymentReconciliation, PaymentReconciliationConfirmation, type ObservedEvent } from "./PaymentReconciliation";

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState), useRef: vi.fn(actual.useRef), useEffect: vi.fn(actual.useEffect) };
});
afterEach(() => { vi.mocked(useState).mockRestore(); vi.mocked(useRef).mockRestore(); vi.mocked(useEffect).mockRestore(); });

const event: ObservedEvent = { ...mockEvents[0]!, id: "chosen", merchantRaw: "OPENAI", status: "accepted",
  occurredAt: "2026-10-18T12:00:00Z", amount: { currency: "MXN", amountMinor: 399_00 }, msi: undefined };
const base = { payment: { id: "fixed", name: "OpenAI", amountMinor: 399_00, dueDay: 18 },
  month: "2026-10", candidates: [event], candidatesLoading: false };

describe("payment reconciliation interaction boundaries", () => {
  it("keeps an explicit selection and confirmation after a save failure so the same action can be retried", async () => {
    const onReconcile = vi.fn().mockRejectedValueOnce(new Error("Cambió la revisión. Intenta de nuevo.")).mockResolvedValueOnce(undefined);
    const onBusyChange = vi.fn();
    const render = stateHarness();
    let view = render({ ...base, onReconcile, onBusyChange });
    expect(onReconcile).not.toHaveBeenCalled();
    find(view, child => child.type === "input" && child.props.type === "radio").props.onChange!();
    view = render({ ...base, onReconcile, onBusyChange });
    button(view, "Revisar vínculo").props.onClick!();
    view = render({ ...base, onReconcile, onBusyChange });
    find(view, child => child.type === PaymentReconciliationConfirmation).props.onConfirm!("chosen");
    await settle();
    view = render({ ...base, onReconcile, onBusyChange });
    expect(renderToStaticMarkup(view)).toContain("Cambió la revisión. Intenta de nuevo.");
    expect(find(view, child => child.type === "input" && child.props.type === "radio").props.checked).toBe(true);
    find(view, child => child.type === PaymentReconciliationConfirmation).props.onConfirm!("chosen");
    await settle();
    view = render({ ...base, onReconcile, onBusyChange });
    expect(onReconcile.mock.calls).toEqual([["chosen"], ["chosen"]]);
    expect(onBusyChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(renderToStaticMarkup(view)).not.toContain("Cambió la revisión");
    expect(nodes(view).some(child => child.type === PaymentReconciliationConfirmation)).toBe(false);
  });

  it("does not commit stale or changed candidate IDs, rejected candidates, or incomplete candidate refreshes", async () => {
    const onReconcile = vi.fn().mockResolvedValue(undefined);
    const render = stateHarness();
    const props = { ...base, onReconcile };
    let view = render(props);
    find(view, child => child.type === "input" && child.props.type === "radio").props.onChange!();
    view = render(props);
    button(view, "Revisar vínculo").props.onClick!();
    view = render(props);
    find(view, child => child.type === PaymentReconciliationConfirmation).props.onConfirm!("other-id");
    await settle();
    expect(onReconcile).not.toHaveBeenCalled();
    for (const next of [{ candidatesLoading: true }, { candidatesError: "Intenta de nuevo" },
      { candidates: [{ ...event, status: "rejected" as const }] }]) {
      view = render({ ...props, ...next });
      const confirmation = nodes(view).find(child => child.type === PaymentReconciliationConfirmation);
      confirmation?.props.onConfirm?.("chosen");
      await settle();
      expect(onReconcile).not.toHaveBeenCalled();
    }
  });

  it("opens the selected charge evidence, recovers from lookup failure, and preserves the candidate selection", async () => {
    const onOpenEvent = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(undefined);
    const onReconcile = vi.fn();
    const render = stateHarness();
    const props = { ...base, onReconcile, onOpenEvent };
    let view = render(props);
    find(view, child => child.type === "input" && child.props.type === "radio").props.onChange!();
    view = render(props);
    button(view, "Ver cobro y evidencia").props.onClick!();
    await settle();
    view = render(props);
    expect(renderToStaticMarkup(view)).toContain("No pudimos abrir este cobro");
    expect(find(view, child => child.type === "input" && child.props.type === "radio").props.checked).toBe(true);
    button(view, "Reintentar evidencia").props.onClick!();
    await settle();
    view = render(props);
    expect(renderToStaticMarkup(view)).not.toContain("No pudimos abrir este cobro");
    expect(onOpenEvent.mock.calls.map(([id]) => id)).toEqual(["chosen", "chosen"]);
    expect(onOpenEvent.mock.calls[0]![1].aborted).toBe(true);
    expect(onOpenEvent.mock.calls[1]![1].aborted).toBe(false);
    expect(onReconcile).not.toHaveBeenCalled();
  });

  it("aborts a pending evidence lookup on unmount and ignores its late result", async () => {
    let finish!: () => void;
    const onOpenEvent = vi.fn((_id: string, _signal: AbortSignal) => new Promise<void>(resolve => { finish = resolve; }));
    const render = stateHarness();
    const props = { ...base, onOpenEvent };
    const view = render(props);
    button(view, "Ver cobro y evidencia").props.onClick!();
    const cleanup = vi.mocked(useEffect).mock.calls[0]![0]() as () => void;
    cleanup();
    expect(onOpenEvent.mock.calls[0]![1].aborted).toBe(true);
    finish(); await settle();
    expect(onOpenEvent).toHaveBeenCalledTimes(1);
  });
});

// Exercise the component's actual callbacks and state transitions without a browser/DOM dependency.
// React's renderer remains responsible for rendering the JSX and confirmation component.
const stateHarness = () => {
  const state: unknown[] = [];
  vi.mocked(useRef).mockReturnValue({ current: undefined });
  vi.mocked(useEffect).mockImplementation(() => {});
  let cursor = 0;
  vi.mocked(useState).mockImplementation((initial?: unknown) => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
    return [state[index], (next: unknown) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
  });
  return (props: Parameters<typeof PaymentReconciliation>[0]) => { cursor = 0; return PaymentReconciliation(props); };
};
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
type Props = { children?: ReactNode; type?: string; checked?: boolean; onClick?: () => void; onChange?: () => void; onConfirm?: (id: string | null) => void };
const nodes = (node: ReactNode): ReactElement<Props>[] => Children.toArray(node).flatMap(child =>
  isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
const find = (node: ReactNode, predicate: (child: ReactElement<Props>) => boolean) => {
  const found = nodes(node).find(predicate);
  if (!found) throw new Error("Expected action missing");
  return found;
};
const button = (node: ReactNode, label: string) => find(node, child => child.type === "button" && child.props.children === label);
