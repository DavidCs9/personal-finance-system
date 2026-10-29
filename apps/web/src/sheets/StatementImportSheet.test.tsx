import { Children, isValidElement, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AmexImportPreview, StatementImportDecision, StatementImportRow, StatementPlanSnapshot } from "../types";
import { ledgerApi } from "../api/client";
import { ManualPlanComparison, StatementImportSheet } from "./StatementImportSheet";

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState), useRef: vi.fn(actual.useRef),
    useCallback: vi.fn(actual.useCallback), useEffect: vi.fn(actual.useEffect) };
});
afterEach(() => { vi.mocked(useState).mockRestore(); vi.mocked(useRef).mockRestore();
  vi.mocked(useCallback).mockRestore(); vi.mocked(useEffect).mockRestore(); vi.restoreAllMocks(); });

const msi = (values: Partial<StatementImportRow> = {}): StatementImportRow => ({
  identity: "statement-plan", kind: "msi", merchantRaw: "COMPRA A MESES", amountMinor: 586_75,
  occurredOn: "2026-09-07", installmentIndex: 1, installmentMonths: 12,
  originalAmountMinor: 7041_00, status: "new", ...values,
});

describe("statement automatic reconciliation review", () => {
  it("shows the automatic plan and link results without asking for already extracted terms", () => {
    const html = review([
      msi(),
      msi({ identity: "existing-plan", merchantRaw: "PLAN EXISTENTE", status: "matched", eventId: "existing" }),
      { identity: "purchase", kind: "purchase", merchantRaw: "TIENDA", amountMinor: 100_00, occurredOn: "2026-09-09", status: "new" },
      msi({ identity: "known-source", status: "duplicate" }),
    ]);
    expect(html).toContain("Plan nuevo del estado");
    expect(html).toContain("Se vinculará al plan existente");
    expect(html).toContain("Cuota 1/12");
    expect(html).toContain("compra total");
    expect(html).toContain("Ya registrado · no se repetirá");
    expect(html).toContain("<strong>1</strong><span>Planes nuevos</span>");
    expect(html).toContain("<strong>1</strong><span>Movimientos nuevos</span>");
    expect(html).toContain("<strong>0</strong><span>Por revisar</span>");
    expect(html).toMatch(/<button class="primary-button" type="button">Aplicar conciliación<\/button>/);
    expect(html).not.toContain("MSI sin plan");
    expect(html).not.toContain("Usar plan del estado");
    expect(html).not.toContain("Crear otro plan");
    expect(html).not.toContain('type="number"');
  });

  it("explains actual conflicting plans and keeps applying blocked until they are reviewed", () => {
    const html = review([msi({ status: "needs_decision", reason: "conflicting_msi_plan",
      candidates: [{ id: "candidate", merchantRaw: "COMPRA PREVIA", months: 12, cuotaMinor: 580_00, principalMinor: 6960_00,
        occurredAt: "2026-10-01T01:00:00Z" }], candidateEventIds: ["candidate"] })]);
    expect(html).toContain("la evidencia no permite vincularlo con seguridad");
    expect(html).toContain("COMPRA PREVIA");
    expect(html).toContain("12 meses");
    expect(html).toContain("$580.00");
    expect(html).toContain("$6,960.00");
    expect(html).toContain("$586.75");
    expect(html).toContain("30 sep 2026");
    expect(html).not.toContain("Crear otro plan");
    expect(html).not.toContain("Completar y crear plan");
    expect(html).not.toContain("Confirmar en plan…");
    expect(html).not.toContain("Usar plan del estado");
    expect(html).toMatch(/<button class="primary-button" type="button" disabled="">Revisa 1 caso<\/button>/);
    expect(html).toContain("No incorporar esta cuota ahora");
  });

  it("identifies a missing purchase total without inventing one from installments", () => {
    const html = review([msi({ status: "needs_decision", reason: "incomplete_msi_schedule", originalAmountMinor: undefined })]);
    expect(html).toContain("Falta una compra total válida en el estado");
    expect(html).toContain("Completar y crear plan");
    expect(html).toContain("Revisa 1 caso");
  });

  it("distinguishes missing installment data and several possible plans", () => {
    const html = review([
      msi({ identity: "incomplete", status: "needs_decision", reason: "incomplete_msi_schedule", installmentMonths: undefined }),
      msi({ identity: "ambiguous", status: "needs_decision", reason: "ambiguous_msi_match",
        candidates: [{ id: "one", merchantRaw: "PLAN UNO" }, { id: "two", merchantRaw: "PLAN DOS" }] }),
    ]);
    expect(html).toContain("El estado no contiene un plazo completo");
    expect(html).toContain("Más de un plan puede corresponder");
    expect(html).toContain("Completar y crear plan");
    expect(html).toContain("No incorporar esta cuota");
    expect(html).toContain("Revisa 2 casos");
  });

  it("does not offer an enabled apply action while saving a resolved statement", () => {
    expect(review([msi()], true)).toMatch(/<button class="primary-button" type="button" disabled="">Aplicando…<\/button>/);
  });

  it("offers a compatible plan selection without offering to create another plan", () => {
    const html = review([msi({ status: "needs_decision", reason: "ambiguous_msi_match",
      candidates: [{ id: "one", merchantRaw: "PLAN UNO" }, { id: "two", merchantRaw: "PLAN DOS" }] })]);
    expect(html).toContain("Confirmar en plan…");
    expect(html).toContain("PLAN UNO");
    expect(html).toContain("PLAN DOS");
    expect(html).not.toContain("Completar y crear plan");
    expect(html).not.toContain('type="number"');
  });

  it("labels an explicitly omitted conflict and enables applying the other rows", () => {
    const html = review([msi({ status: "needs_decision", reason: "conflicting_msi_plan" })], false,
      { "statement-plan": { action: "skip" } });
    expect(html).toContain("No se incorporará ahora");
    expect(html).toContain("Sin incorporar ahora ✓");
    expect(html).toContain("<strong>0</strong><span>Por revisar</span>");
    expect(html).toMatch(/<button class="primary-button" type="button">Aplicar conciliación<\/button>/);
  });

  it("opens plan evidence with loading and retry while preserving the reconciliation decision", async () => {
    const onOpenEvent = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(undefined);
    const render = stateHarness([msi({ status: "needs_decision", reason: "ambiguous_msi_match",
      candidates: [{ id: "candidate", merchantRaw: "PLAN EXISTENTE" }] })]);
    const props = { ...sheetProps, onOpenEvent };
    let view = render(props);
    find(view, child => child.type === "select").props.onChange!({ target: { value: "candidate" } });
    view = render(props);
    button(view, "Ver plan y evidencia").props.onClick!();
    view = render(props);
    expect(renderToStaticMarkup(view)).toContain("Abriendo movimiento y evidencia…");
    await settle();
    view = render(props);
    expect(renderToStaticMarkup(view)).toContain("No pudimos abrir este movimiento");
    expect(renderToStaticMarkup(view)).toContain("Se vinculará al plan elegido");
    button(view, "Reintentar evidencia").props.onClick!();
    await settle();
    view = render(props);
    expect(renderToStaticMarkup(view)).not.toContain("No pudimos abrir este movimiento");
    expect(renderToStaticMarkup(view)).toContain("Se vinculará al plan elegido");
    expect(onOpenEvent.mock.calls.map(([id]) => id)).toEqual(["candidate", "candidate"]);
    expect(onOpenEvent.mock.calls[0]![1].aborted).toBe(true);
    expect(onOpenEvent.mock.calls[1]![1].aborted).toBe(false);
  });

  it("aborts a pending evidence lookup when the import sheet closes", async () => {
    let finish!: () => void;
    const onOpenEvent = vi.fn((_id: string, _signal: AbortSignal) => new Promise<void>(resolve => { finish = resolve; }));
    const render = stateHarness([msi({ status: "needs_decision", reason: "conflicting_msi_plan",
      candidates: [{ id: "candidate", merchantRaw: "PLAN EXISTENTE" }] })]);
    button(render({ ...sheetProps, onOpenEvent }), "Ver plan y evidencia").props.onClick!();
    const cleanup = vi.mocked(useEffect).mock.calls[0]![0]() as () => void;
    cleanup();
    expect(onOpenEvent.mock.calls[0]![1].aborted).toBe(true);
    finish(); await settle();
    expect(onOpenEvent).toHaveBeenCalledTimes(1);
  });

  it("refreshes the retained PDF review, preserves choices after failure, and resets them only after success", async () => {
    const original = msi({ status: "needs_decision", reason: "ambiguous_msi_match",
      candidates: [{ id: "candidate", merchantRaw: "PLAN EXISTENTE" }] });
    const fresh = previewFor([msi()]);
    const getImport = vi.spyOn(ledgerApi, "getAmexStatementImport")
      .mockRejectedValueOnce(new Error("No pudimos consultar el estado."))
      .mockResolvedValueOnce(fresh);
    const upload = vi.spyOn(ledgerApi, "previewAmexStatement");
    const render = stateHarness([original]);
    let view = render(sheetProps);
    find(view, child => child.type === "select").props.onChange!({ target: { value: "candidate" } });
    view = render(sheetProps);
    button(view, "Actualizar revisión").props.onClick!();
    view = render(sheetProps);
    expect(renderToStaticMarkup(view)).toContain("Actualizando revisión…");
    await settle();
    view = render(sheetProps);
    expect(renderToStaticMarkup(view)).toContain("No pudimos consultar el estado.");
    expect(renderToStaticMarkup(view)).toContain("Se vinculará al plan elegido");
    button(view, "Actualizar revisión").props.onClick!();
    await settle();
    view = render(sheetProps);
    const html = renderToStaticMarkup(view);
    expect(html).toContain("Plan nuevo del estado");
    expect(html).not.toContain("Se vinculará al plan elegido");
    expect(html).not.toContain("No pudimos consultar el estado.");
    expect(html).toMatch(/<button class="primary-button" type="button">Aplicar conciliación<\/button>/);
    expect(getImport.mock.calls).toEqual([["retained-pdf", "session"], ["retained-pdf", "session"]]);
    expect(upload).not.toHaveBeenCalled();
  });

  it("compares a manual plan with literal statement data before preparing its explicit link", () => {
    const row = manualReconciliationRow();
    const candidate = row.candidates![0]!;
    const onSelect = vi.fn();
    const view = ManualPlanComparison({ row, candidate, accountLastFour: "1234", disabled: false, onSelect });
    const html = renderToStaticMarkup(view);
    expect(html).toContain("Plan manual");
    expect(html).toContain("Estado de cuenta");
    expect(html).toContain("$7,000.00");
    expect(html).toContain("$7,041.00");
    expect(html).toContain("$583.33");
    expect(html).toContain("$586.75");
    expect(html).toContain("oct 2026");
    expect(html).toContain("sep 2026");
    expect(html).toContain("Sin identificar");
    expect(html).toContain("1234");
    expect(onSelect).not.toHaveBeenCalled();
    button(view, "Vincular a este plan con los datos del estado").props.onClick!();
    expect(onSelect.mock.calls).toEqual([[{ action: "reconcile_plan", eventId: "manual-plan", expectedPlan: manualSnapshot }]]);
  });

  it("keeps ineligible conflicts out of the explicit manual reconciliation action", () => {
    const row = manualReconciliationRow();
    const candidate = row.candidates![0]!;
    for (const next of [{ ...candidate, canReconcilePlan: false }, { ...candidate, expectedPlan: undefined }]) {
      expect(ManualPlanComparison({ row, candidate: next, accountLastFour: "1234", disabled: false, onSelect: vi.fn() })).toBeNull();
    }
    expect(ManualPlanComparison({ row: { ...row, originalOn: undefined }, candidate, accountLastFour: "1234", disabled: false, onSelect: vi.fn() })).toBeNull();
  });

  it("sends the exact reviewed manual snapshot only when applying the prepared reconciliation", async () => {
    const row = manualReconciliationRow();
    const decision: StatementImportDecision = { action: "reconcile_plan", eventId: "manual-plan", expectedPlan: manualSnapshot };
    const apply = vi.spyOn(ledgerApi, "applyAmexStatement").mockResolvedValue({ importId: "retained-pdf", created: [],
      summary: { created: 0, linked: 0, skipped: 0, msiConfirmed: 1, createdUnplanned: 0 } });
    const render = stateHarness([row], { [row.identity]: decision });
    const view = render(sheetProps);
    const html = renderToStaticMarkup(view);
    expect(html).toContain("Vínculo preparado ✓");
    expect(html).toContain("Se vinculará al plan manual con los datos del estado");
    expect(html).toContain("<strong>1</strong><span>Se vincularán</span>");
    expect(html).toContain("<strong>0</strong><span>Por revisar</span>");
    expect(apply).not.toHaveBeenCalled();
    button(view, "Aplicar conciliación").props.onClick!();
    await settle();
    expect(apply.mock.calls).toEqual([["retained-pdf", { [row.identity]: decision }, "session"]]);
  });
});

const manualSnapshot: StatementPlanSnapshot = { principalMinor: 7000_00, cuotaMinor: 583_33, months: 12,
  startMonth: "2026-10", occurredAt: "2026-09-07T12:00:00Z", accountLastFour: null };
const manualReconciliationRow = () => msi({ status: "needs_decision", reason: "conflicting_msi_plan", originalOn: "2026-09-07",
  candidates: [{ id: "manual-plan", merchantRaw: "COMPRA MANUAL", canReconcilePlan: true, expectedPlan: manualSnapshot }] });

// Render the real sheet with an already loaded server preview, without uploading a file.
const previewFor = (rows: readonly StatementImportRow[]): AmexImportPreview => {
  const count = (status: StatementImportRow["status"]) => rows.filter(row => row.status === status).length;
  return { importId: "retained-pdf", status: "ready", product: "Tarjeta", accountLastFour: "1234",
    period: { from: "2026-09-07", to: "2026-10-06" }, rows,
    summary: { total: rows.length, new: count("new"), matched: count("matched"), ambiguous: count("ambiguous"),
      duplicate: count("duplicate"), excluded: count("excluded"), needsDecision: count("needs_decision"), skipped: count("skipped"),
      purchases: rows.filter(row => row.kind === "purchase").length, msi: rows.filter(row => row.kind === "msi").length } };
};
const sheetProps = { provider: "amex" as const, idToken: "session", onClose: () => undefined, onApplied: () => undefined };
const review = (rows: readonly StatementImportRow[], busy = false,
  decisions: Readonly<Record<string, StatementImportDecision>> = {}) => {
  const preview = previewFor(rows);
  let cursor = 0;
  vi.mocked(useState).mockImplementation((initial?: unknown) => {
    const index = cursor++;
    return [index === 1 ? preview : index === 2 ? decisions : index === 5 ? busy : typeof initial === "function" ? initial() : initial, vi.fn()];
  });
  return renderToStaticMarkup(<StatementImportSheet {...sheetProps} />);
};

// Exercise callback boundaries with stable hook values; browser QA covers DOM layout and scheduling.
const stateHarness = (rows: readonly StatementImportRow[], decisions: Readonly<Record<string, StatementImportDecision>> = {}) => {
  const state: unknown[] = [];
  const controllerRef = { current: undefined };
  const cancelledRef = { current: false };
  vi.mocked(useRef).mockImplementation((initial: unknown) => initial === false ? cancelledRef : controllerRef);
  vi.mocked(useEffect).mockImplementation(() => {});
  vi.mocked(useCallback).mockImplementation(callback => callback);
  let cursor = 0;
  vi.mocked(useState).mockImplementation((initial?: unknown) => {
    const index = cursor++;
    if (!(index in state)) state[index] = index === 1 ? previewFor(rows) : index === 2 ? decisions : typeof initial === "function" ? initial() : initial;
    return [state[index], (next: unknown) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
  });
  return (props: Parameters<typeof StatementImportSheet>[0]) => { cursor = 0; return StatementImportSheet(props); };
};
const settle = async () => { for (let turn = 0; turn < 4; turn += 1) await Promise.resolve(); };
type Props = { children?: ReactNode; type?: string; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void };
const nodes = (node: ReactNode): ReactElement<Props>[] => Children.toArray(node).flatMap(child =>
  isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
const find = (node: ReactNode, predicate: (child: ReactElement<Props>) => boolean) => {
  const found = nodes(node).find(predicate);
  if (!found) throw new Error("Expected action missing");
  return found;
};
const button = (node: ReactNode, label: string) => find(node, child => child.type === "button" && child.props.children === label);
