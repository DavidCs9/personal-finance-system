import { describe, expect, it } from "vitest";
import { InvalidSantanderCsvError, merchantsMatch, parseSantanderCsv, santanderApplyAction, santanderImportCompletionUpdate } from "../lambda/santander-csv.js";

const fixture = `No. de Tarjeta: 4262**6349
Producto: UNIQUE REWARDS PLATINUM V
TASA DE INTERÉS ANUALIZADA: 56.46 %
Detalle del 01/ago/2026 al 02/ago/2026,Total de movimientos: 5
FECHA,CONSECUTIVO,CONCEPTO,IMPORTE
31/Jul/2026,2621240485333238,BOTICA MIRADOR ,$ 52.36
01/Ago/2026,2621340486795734,OXXO HDAS DE VA,$ 128.00
07/Jul/2026,,PAGO POR TRANSFERENCIA,$ -13,790.52
03/Jul/2026,,AMAZON A MESES,$ 237.92
03/Jul/2026,,AMAZON A MESES,$ 237.92`;

describe("Santander CSV", () => {
  it("parses the downloaded statement and preserves signed amounts", () => {
    const document = parseSantanderCsv(fixture);
    expect(document).toMatchObject({
      accountLastFour: "6349",
      declaredMovements: 5,
      period: { from: "2026-08-01", to: "2026-08-02" },
    });
    expect(document.rows).toHaveLength(5);
    expect(document.rows[0]).toMatchObject({
      occurredOn: "2026-07-31",
      transactionId: "2621240485333238",
      merchantRaw: "BOTICA MIRADOR",
      amountMinor: 5236,
    });
    expect(document.rows.find((row) => row.merchantRaw === "PAGO POR TRANSFERENCIA")?.amountMinor).toBe(-1379052);
  });

  it("gives repeated rows without a consecutive distinct stable identities", () => {
    const document = parseSantanderCsv(fixture);
    const withoutTransactionId = document.rows.filter((row) => !row.transactionId);
    expect(withoutTransactionId).toHaveLength(3);
    expect(withoutTransactionId.every((row) => !Object.values(row).includes(undefined))).toBe(true);
    expect(withoutTransactionId.every((row) => !Object.hasOwn(row, "transactionId"))).toBe(true);
    expect(new Set(withoutTransactionId.map((row) => row.identity)).size).toBe(3);
  });

  it("matches Santander-truncated merchant names, but rejects weak similarities", () => {
    expect(merchantsMatch("OXXO HDAS DE VALLE CUF", "OXXO HDAS DE VA")).toBe(true);
    expect(merchantsMatch("AMAZON WEB SERVICES", "Amazon web serv")).toBe(true);
    expect(merchantsMatch("OXXO", "OXXO RINCONES CUU")).toBe(false);
  });

  it("rejects a row-count mismatch", () => {
    expect(() => parseSantanderCsv(fixture.replace("Total de movimientos: 5", "Total de movimientos: 6")))
      .toThrow(InvalidSantanderCsvError);
  });

  it("refuses to apply a stale preview when the reconciliation candidate changes", () => {
    expect(santanderApplyAction(
      { status: "matched", candidateEventIds: ["email-2"] },
      { status: "matched", candidateEventIds: ["email-1"] },
    )).toEqual({ kind: "skip" });
    expect(santanderApplyAction(
      { status: "matched", candidateEventIds: ["email-1"] },
      { status: "new", candidateEventIds: [] },
    )).toEqual({ kind: "skip" });
  });

  it("requires and validates an explicit decision for ambiguous rows", () => {
    const state = { status: "ambiguous" as const, candidateEventIds: ["email-1", "email-2"] };
    expect(santanderApplyAction(state, state)).toEqual({ kind: "skip" });
    expect(santanderApplyAction(state, state, { action: "create" })).toEqual({ kind: "create" });
    expect(santanderApplyAction(state, state, { action: "link", eventId: "email-2" })).toEqual({ kind: "link", eventId: "email-2" });
    expect(santanderApplyAction(state, state, { action: "link", eventId: "email-3" })).toEqual({ kind: "skip" });
  });

  it("aliases every import completion attribute used by DynamoDB", () => {
    const update = santanderImportCompletionUpdate("2026-08-02T15:33:17.000Z", { created: 2, linked: 1, skipped: 3 });
    expect(update).toEqual({
      UpdateExpression: "SET #status = :status, #appliedAt = :appliedAt, #result = :result",
      ExpressionAttributeNames: { "#status": "status", "#appliedAt": "appliedAt", "#result": "result" },
      ExpressionAttributeValues: {
        ":status": "applied",
        ":appliedAt": "2026-08-02T15:33:17.000Z",
        ":result": { created: 2, linked: 1, skipped: 3 },
      },
    });
  });
});
