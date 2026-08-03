# Meses sin intereses (MSI)

Cómo Olbia modela, importa y muestra compras a plazos. La UI operativa vive en [`apps/web/AGENTS.md`](../apps/web/AGENTS.md) y [`ui-design-brief.md`](ui-design-brief.md); las decisiones de producto compactas siguen en [`v1-decisions.md`](v1-decisions.md).

## Idea central

Un MSI **no es un gasto fijo indefinido**. Es un plan con:

- **Principal** (total de la compra)
- **Cuota** mensual
- **N meses** con inicio y fin
- Una fila por mes: `committed` → `spent` (nunca ambos a la vez)

El plan vive en el evento observado (`ObservedPurchase.msi`), no en `MonthlyPlan` (ahí solo van ingreso y gastos fijos tipo renta/subs).

## Cómo cuenta el mes

| Concepto | Qué suma |
| --- | --- |
| **Has gastado** | Compras discrecionales del mes + cuotas MSI en `spent` para ese `YYYY-MM` |
| **Te quedan / compromisos** | Gastos fijos del mes + cuotas MSI aún `committed` |
| **A este ritmo** | Ritmo solo sobre gasto discrecional; luego suma MSI gastadas y compromisos pendientes |

El **principal completo no infla** el mes: solo la cuota del mes.

## UI

- **Resumen → Planes con fin:** lista de cuotas del mes seleccionado (gastadas y pendientes), con total, `i/N` y rango inicio–fin.
- **Resumen → Gastos fijos:** renta, iCloud, etc. Sin fecha de fin. No mezclar MSI aquí.
- **Movimientos:** lista raw ordenable. Si un evento tiene MSI, badge `MSI i/N` y monto = **cuota del mes** (no el ticket). No se duplica el bloque “Planes con fin”.

## Ciclo de una cuota

1. Al crear el plan, las cuotas futuras quedan `committed` (restan de “Te quedan”).
2. Al reconciliar evidencia del estado/CSV (o al crear el plan sobre la cuota del periodo), esa cuota pasa a `spent` (suma a “Has gastado”).
3. Las cuotas **anteriores** al índice evidenciado se marcan `spent` (se asume que ya se pagaron en estados previos). Nunca se dejan `committed` en el pasado.
4. `cancelled` se usa en liquidación anticipada (manual).

## Orígenes del plan (`msi.origin`)

| Origen | Cuándo |
| --- | --- |
| `amex_auto` | Alerta Amex con importe **> $2,500** → asume 3 MSI al crear el evento; también al crear plan desde etiqueta “MESES EN AUTOMÁTICO” con metadata del estado |
| `manual` | `create_plan` explícito en import (comercio real, Amazon, etc.) |
| `statement_unplanned` | Legado / stubs incompletos; **ya no se inventan** en apply de estados |

## Import: estado de cuenta (Amex / Santander PDF)

Path preferido para MSI porque trae **comercio, cuota, `i/N`, total y fechas**.

1. `POST /imports/{amex\|santander-statement}/preview` → Textract AnalyzeDocument → poll → filas de compra + filas MSI.
2. Compras: `new` / `matched` / `ambiguous` / `duplicate` (como el CSV).
3. MSI:
   - **`matched`:** la cuota encaja con un plan existente → apply confirma (`spent`).
   - **`needs_decision`:** no hay plan → la UI pide decisión. **No se inventa schedule solo.**

### Decisiones MSI en apply

| Acción | Efecto |
| --- | --- |
| **Crear plan** | Abre schedule con meses/cuota (y total si viene en la fila). Índice `i` del estado: cuotas `< i` → `spent`; cuota `i` → `spent` con evidencia; resto → `committed`. El mes de inicio se retrocede desde la fecha de la cuota: `start = mes(cuota) − (i − 1)`. |
| **Usar plan del estado / omitir con `n/N`** | Si la fila ya trae `installmentIndex` + `installmentMonths` (y monto), omitir **crea el plan** con esos datos en lugar de tirar el gasto. |
| **Omitir sin metadata** | No crea evento ni plan (la cuota no entra al tablero). |
| **Confirmar en plan…** | Enlaza la cuota a un candidato existente. |

### Santander PDF

La tabla de “compras a meses” (`12M S/INT`, `03 DE 12`, monto original, pago requerido) **enriquece** las filas de movimiento `AMAZON A MESES` con `installmentIndex`, `installmentMonths` y `originalAmountMinor`. Sin eso, un `create_plan` puede asumir cuota `1/N` desde la fecha del cargo y desalinear el calendario.

### Amex “MESES EN AUTOMÁTICO”

No es el comercio real: es una etiqueta agregada. El PDF suele traer igual `CARGO i DE N`, cuota y monto original. Con esa metadata **sí se puede abrir un plan** bajo ese nombre para no perder el gasto mensual. Idealmente el plan viviría en la compra original; si el estado no la trae, el plan sobre la etiqueta es el fallback consciente.

Tolerancia de importe MSI: **$2.00** (`MSI_AMOUNT_TOLERANCE_MINOR`).

## Import: CSV Santander

Path más viejo, útil para **movimientos del periodo** y para **confirmar** cuotas de planes ya existentes.

- Dedupe por identidad de fila; preview antes de apply.
- Filas MSI-like (`A MESES`, etc.): si matchean un plan → confirman cuota; si no → `needs_decision`.
- El CSV **casi nunca trae `n/N` ni total**. No uses `create_plan` desde CSV si el plan ya existe o si desconoces el plazo: confirma u omite.
- Para abrir MSI nuevos con calendario correcto, preferir el **estado PDF**.

## Reglas operativas (checklist)

1. En decide: si ves `i/N` y total, **crear / usar plan del estado** — no omitir a ciegas.
2. No inventar meses “porque sí”; el PDF manda.
3. CSV de un mes nuevo: llenar compras + confirmar cuotas Amazon/Amex ya planeadas; evitar `create_plan` improvisado.
4. Gastos fijos ≠ MSI.
5. Liquidación anticipada: cancelar cuotas restantes a mano y registrar el cargo de cierre si aplica.

## Modelo en datos (resumen)

```ts
msi: {
  months: number;
  cuotaMinor: number;
  principalMinor: number;
  origin: "amex_auto" | "manual" | "statement_unplanned";
  status: "active" | "completed" | "cancelled";
  installments: Array<{
    index: number;          // 1..months
    month: string;          // YYYY-MM
    amountMinor: number;
    status: "committed" | "spent" | "cancelled";
    evidenceObservationId?: string;
    confirmedAt?: string;
  }>;
}
```

Implementación de dominio: `packages/domain/src/msi.ts` y `month-summary.ts`. Conciliación: `infrastructure/lambda/msi-reconciliation.ts`, `statement-reconciliation.ts`, parsers Amex/Santander statement y CSV.
