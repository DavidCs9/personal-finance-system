# Patrimonio

Plan operativo de la tab **Patrimonio** (activos).

## Decisiones

- Solo **activos** (Cajita Nu, Fondo de ahorro, Bitso, IBKR). Sin restar deudas de tarjetas.
- Tab propia, hermana de Resumen y Movimientos.
- Reporte en **MXN**; moneda nativa queda en holdings.
- Snapshots **diarios** canónicos por cuenta líquida (`America/Chihuahua`); holdings **embebidos**.
- **Fondo de ahorro** es derivado de CFDIs de nómina (suma de deducciones SAT `004` del año calendario). Cuenta en **Tienes** al 100% con etiqueta illíquida hasta diciembre. No se persiste como `WEALTH_SNAP`; el reset por liquidación de diciembre llega en un slice posterior.
- Misma `MetadataTable`. Historial **sin TTL**.
- Misma día: replace del canónico; versión previa solo auditoría.
- Evidencia cruda en S3 (`wealth-manual/…`, `wealth-api/…`).
- Cajita: captura manual de solo saldo; fecha del sistema; inmutable; stale a **7 días**.
- Bitso: sync read-only vía API (balances + tickers `*_mxn`); schedule **06:30** Chihuahua; refresh manual `POST /wealth/sync/bitso`.
- IBKR: Flex Web Service (posiciones + cash USD) + Banxico FIX `SF43718`; schedule **06:45** Chihuahua; refresh manual `POST /wealth/sync/ibkr`.
- Fallos de sync Bitso/IBKR: se conserva el último snapshot bueno; **push + email**.
- FX: Bitso con tickers propios; IBKR con Banxico. Holdings no-USD de IBKR se omiten (skipped).

## API

- `GET /wealth` — cuentas sembradas (incl. fondo derivado), últimos snapshots, historial.
- `POST /wealth/accounts/nu_cajita_emergencia/snapshots` — `{ amountMinor }` MXN.
- `POST /wealth/sync/bitso` — sync manual (JWT owner); secret `{ apiKey, apiSecret, owner }`.
- `POST /wealth/sync/ibkr` — sync manual; secret `{ flexToken, flexQueryId, banxicoToken, owner }`.

## Infra

- Secret `BitsoApiSecret` / `IbkrApiSecret` (placeholders `pending` hasta configurar).
- Lambdas `personal-finance-v1-bitso-sync` y `personal-finance-v1-ibkr-sync` + Scheduler + DLQ.
- API Lambda lee ambos secrets para refresh manual.

## UI

- Hero: **Tienes** + total MXN; en vista total, **Bitso / Actualizar**.
- Desglose por cuenta; holdings al seleccionar Bitso o IBKR; fondo muestra YTD illíquido.
- Historial numérico + sparkline mínima.
- Selector de mes visible pero deshabilitado en Patrimonio.

## Relacionado

- [Dirección de producto y UI](ui-design-brief.md)
- [AGENTS web](../apps/web/AGENTS.md)
