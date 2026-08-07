# Patrimonio

Plan operativo de la tab **Patrimonio** (activos − deudas de tarjeta = neto).

## Decisiones

- Hero en vista total: **Neto** = activos − saldos pendientes de tarjetas.
- Activos: Cajita Nu, Fondo de ahorro, Bitso, IBKR.
- Pasivos: hasta 3 tarjetas (`CARD#`); captura **manual** del saldo pendiente total (incluye MSI), como aparece en la app/estado de cuenta.
- Las tarjetas de Resumen siguen siendo solo ciclo (corte/pago). El saldo vive en Patrimonio, no en el sheet de ciclos.
- Tab propia, hermana de Resumen y Movimientos.
- Reporte en **MXN**; moneda nativa queda en holdings.
- Snapshots **diarios** canónicos por cuenta líquida (`America/Chihuahua`); holdings **embebidos**.
- **Fondo de ahorro** es derivado de CFDIs de nómina (suma de deducciones SAT `004` del año calendario). Cuenta en activos al 100% con etiqueta illíquida hasta diciembre. No se persiste como `WEALTH_SNAP`; el reset por liquidación de diciembre llega en un slice posterior.
- Misma `MetadataTable`. Historial **sin TTL**.
- Misma día: replace del canónico; versión previa solo auditoría.
- Evidencia cruda en S3 (`wealth-manual/…`, `wealth-api/…`).
- Cajita: captura manual de solo saldo; fecha del sistema; inmutable; stale a **7 días**.
- Tarjetas (pasivo): captura manual `{ amountMinor }` (≥ 0; 0 = pagada); fecha del sistema; inmutable mismo día; stale a **7 días**. Persistencia `LIAB_SNAP#` / `LIAB_VER#` ligada a `cardId`.
- Bitso: sync read-only vía API (balances + tickers `*_mxn`); schedule **06:30** Chihuahua; refresh manual `POST /wealth/sync/bitso`.
- IBKR: Flex Web Service (posiciones + cash USD) + Banxico FIX `SF43718`; schedule **06:45** Chihuahua; refresh manual `POST /wealth/sync/ibkr`.
- Fallos de sync Bitso/IBKR: se conserva el último snapshot bueno; **push + email**.
- FX: Bitso con tickers propios; IBKR con Banxico. Holdings no-USD de IBKR se omiten (skipped).
- Historial en vista total: **neto** mensual (cierre por mes desde `2026-08`; carry-forward de saldos de tarjeta). Al filtrar una cuenta de activo, el historial sigue siendo solo esa cuenta (día a día).

## API

- `GET /wealth` — cuentas sembradas (incl. fondo derivado), pasivos por tarjeta, `assetsMxnMinor`, `liabilitiesMxnMinor`, `netMxnMinor`, `totalMxnMinor` (= assets, alias), historial.
- `POST /wealth/accounts/nu_cajita_emergencia/snapshots` — `{ amountMinor }` MXN (> 0).
- `POST /wealth/liabilities/{cardId}/snapshots` — `{ amountMinor }` MXN (≥ 0); exige `CARD#{cardId}` existente.
- `POST /wealth/sync/bitso` — sync manual (JWT owner); secret `{ apiKey, apiSecret, owner }`.
- `POST /wealth/sync/ibkr` — sync manual; secret `{ flexToken, flexQueryId, banxicoToken, owner }`.

## Infra

- Secret `BitsoApiSecret` / `IbkrApiSecret` (placeholders `pending` hasta configurar).
- Lambdas `personal-finance-v1-bitso-sync` y `personal-finance-v1-ibkr-sync` + Scheduler + DLQ.
- API Lambda lee ambos secrets para refresh manual.

## UI

- Hero vista total: **Neto** + meta Activos · Debes; en vista total, un **Actualizar** dispara Bitso e IBKR a la vez.
- Al filtrar cuenta de activo, el hero muestra solo ese activo.
- Desglose **Dónde está** (activos); sección **Debes** (tarjetas + captura); holdings al seleccionar Bitso o IBKR; fondo muestra YTD illíquido.
- Historial numérico + sparkline mínima. La vista total usa **tendencia mensual** del neto (cierre por mes) desde `2026-08`; el prehistorial incompleto se omite. Al abrir una cuenta, el historial sigue siendo por día de captura/nómina.
- Selector de mes usable en Patrimonio (cambia el periodo global; el total de patrimonio no es un corte mensual).

## Relacionado

- [Dirección de producto y UI](ui-design-brief.md)
- [AGENTS web](../apps/web/AGENTS.md)
