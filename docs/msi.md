# Meses sin intereses (MSI)

Compras a plazos con **total fijo, cuota y fecha de fin**. No son gastos fijos (renta, subs): esos no tienen fin.

El plan vive en el evento de la compra (`msi`). El ingreso y los gastos fijos viven aparte, en el plan del mes.

## Qué ve el mes

- **Has gastado** = compras normales + cuotas MSI ya reconciliadas (`spent`).
- **Te quedan** resta también las cuotas MSI aún pendientes (`committed`).
- Solo cuenta la **cuota del mes**, nunca el ticket completo.

## Dónde se ve en la app

- **Resumen → Planes con fin:** cuotas del mes (gastadas y pendientes).
- **Resumen → Gastos fijos:** servicios/subs indefinidos. Sin MSI.
- **Movimientos:** lista simple. Si hay MSI, badge `MSI i/N` y monto = cuota del mes.

## Cómo avanza una cuota

1. Al abrir el plan, las cuotas futuras quedan **pendientes**.
2. Cuando el estado o el CSV confirma esa cuota, pasa a **gastada**.
3. Las cuotas anteriores a la del estado también se marcan gastadas (ya se pagaron antes).
4. Si liquidas antes de tiempo, cancelas el resto a mano.

El plan **siempre** arranca en `1/n`. Si el PDF trae `2/3`, Olbia retrocede el calendario, marca `1/3` como gastada y ancla el movimiento al mes de la primera cuota para que aparezca en mayo, junio y julio.

## Cómo entra a Olbia

**Estado de cuenta PDF (Amex / Santander)** — el camino bueno para MSI. Trae comercio, cuota, `i/N` y a veces el total.

- Si la cuota encaja con un plan → se confirma.
- Si no hay plan → decides en la UI:
  - **Crear plan** / **Usar plan del estado:** abre el calendario. Si el PDF dice `3/12`, las 1–2 quedan gastadas, la 3 gastada con evidencia, el resto pendiente.
  - **Omitir** sin `i/N`: no guarda nada (pierdes ese gasto en el tablero).
  - Si el PDF ya trae `i/N`, omitir **crea el plan** con esos datos (no tira el gasto).

Santander usa la tabla de “a meses” (`12M`, `03 DE 12`, total) para no asumir por error que la cuota es la `1/N`.

Amex **MESES EN AUTOMÁTICO** no es un comercio real, pero el PDF sí trae `i/N` y montos. Se puede abrir plan con eso para no perder el mes; lo ideal sería la compra original si aparece.

**CSV Santander** — más viejo. Sirve para movimientos del mes y para **confirmar** cuotas de planes que ya existen. Casi nunca trae `i/N`: no inventes un plan nuevo desde el CSV; confirma u omite. Para MSI nuevos, usa el PDF.

## Reglas cortas

1. Si el PDF trae `i/N` (y total), crea o usa el plan del estado.
2. No inventes meses; manda el PDF.
3. CSV: llena el mes y confirma cuotas ya planeadas; no armes planes a ciegas.
4. Gastos fijos ≠ MSI.
5. Cierre anticipado: manual.
6. Un plan = un comercio + principal. Si ya existe, la siguiente cuota **confirma**; no abras otro plan.

Detalle de producto/API: [`v1-decisions.md`](v1-decisions.md). Código: `packages/domain/src/msi.ts`, `infrastructure/lambda/msi-reconciliation.ts`.
