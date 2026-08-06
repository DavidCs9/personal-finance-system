# Patrimonio

Plan operativo de la tab **Patrimonio** (activos). El LLM y los ingresos por XML quedan fuera de esta fase.

## Decisiones

- Solo **activos** (Cajita Nu, Bitso, IBKR). Sin restar deudas de tarjetas.
- Tab propia, hermana de Resumen y Movimientos.
- Reporte en **MXN**; moneda nativa queda en holdings.
- Snapshots **diarios** canónicos por cuenta (`America/Chihuahua`); holdings **embebidos**.
- Misma `MetadataTable`. Historial **sin TTL**.
- Misma día: replace del canónico; versión previa solo auditoría.
- Evidencia cruda en S3 (manual Cajita y, después, APIs).
- Cajita: captura manual de solo saldo; fecha del sistema; inmutable; stale a **7 días**.
- Primer ship: modelo + tab + Cajita. Bitso e IBKR visibles pero pendientes.
- Fallos de sync (fase siguiente): último snapshot bueno + badge; push + email.
- FX IBKR (fase siguiente): Banxico; Bitso con tickers propios.

## API

- `GET /wealth` — cuentas sembradas, últimos snapshots, historial.
- `POST /wealth/accounts/nu_cajita_emergencia/snapshots` — `{ amountMinor }` MXN.

## UI

- Hero: **Tienes** + total MXN.
- Desglose por cuenta; Bitso/IBKR en “Sin conectar”.
- Historial numérico (lista) + sparkline mínima; filtro al seleccionar cuenta.
- Sin “Actualizar ahora” en esta fase. El selector de mes permanece visible pero deshabilitado.

## Relacionado

- [Dirección de producto y UI](ui-design-brief.md)
- [AGENTS web](../apps/web/AGENTS.md)
