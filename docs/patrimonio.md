# Patrimonio

Plan operativo de la tab **Patrimonio** (activos). El LLM y los ingresos por XML quedan fuera de esta fase.

## Decisiones

- Solo **activos** (Cajita Nu, Bitso, IBKR). Sin restar deudas de tarjetas.
- Tab propia, hermana de Resumen y Movimientos.
- Reporte en **MXN**; moneda nativa queda en holdings.
- Snapshots **diarios** canónicos por cuenta (`America/Chihuahua`); holdings **embebidos**.
- Misma `MetadataTable`. Historial **sin TTL**.
- Misma día: replace del canónico; versión previa solo auditoría.
- Evidencia cruda en S3 (`wealth-manual/…`, `wealth-api/…`).
- Cajita: captura manual de solo saldo; fecha del sistema; inmutable; stale a **7 días**.
- Bitso: sync read-only vía API (balances + tickers `*_mxn`); schedule **06:30** Chihuahua; refresh manual `POST /wealth/sync/bitso`.
- IBKR: Flex Web Service (posiciones + cash USD) + Banxico FIX `SF43718`; schedule **06:45** Chihuahua; refresh manual `POST /wealth/sync/ibkr`.
- Fallos de sync Bitso/IBKR: se conserva el último snapshot bueno; **push + email**.
- FX: Bitso con tickers propios; IBKR con Banxico. Holdings no-USD de IBKR se omiten (skipped).

## API

- `GET /wealth` — cuentas sembradas, últimos snapshots, historial.
- `POST /wealth/accounts/nu_cajita_emergencia/snapshots` — `{ amountMinor }` MXN.
- `POST /wealth/sync/bitso` — sync manual (JWT owner); secret `{ apiKey, apiSecret, owner }`.
- `POST /wealth/sync/ibkr` — sync manual; secret `{ flexToken, flexQueryId, banxicoToken, owner }`.

## Infra

- Secret `BitsoApiSecret` / `IbkrApiSecret` (placeholders `pending` hasta configurar).
- Lambdas `personal-finance-v1-bitso-sync` y `personal-finance-v1-ibkr-sync` + Scheduler + DLQ.
- API Lambda lee ambos secrets para refresh manual.

## UI

- Hero: **Tienes** + total MXN; en vista total, **Bitso / Actualizar**.
- Desglose por cuenta; holdings al seleccionar Bitso o IBKR.
- Historial numérico + sparkline mínima.
- Selector de mes visible pero deshabilitado en Patrimonio.

## Relacionado

- [Dirección de producto y UI](ui-design-brief.md)
- [AGENTS web](../apps/web/AGENTS.md)
