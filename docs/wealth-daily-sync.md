# Patrimonio diario (Bitso + IBKR)

## Estado

**Plan / no implementado.** Este documento fija el alcance futuro: un dashboard de ahorros e inversiones que se actualiza **una vez al día**, sin datos en vivo y sin APIs de trading complejas. La V1 de Olbia (gasto con tarjeta) no cambia.

## Objetivo

Que Olbia sea, a la larga, el lugar donde consultar **todo** lo financiero: gasto del mes **y** patrimonio (crypto, broker, efectivo).

Dos dominios distintos:

| Dominio | Hoy (V1) | Futuro |
| --- | --- | --- |
| Gasto del mes | Amex / Santander / Apple Pay → eventos observados | sin cambio |
| Patrimonio | — | Bitso + IBKR (+ otras cuentas después) → snapshots diarios |

No mezclar: un snapshot de Bitso no es un “evento observado” de compra. El modelo de gasto permanece; patrimonio es un ledger aparte de saldos y posiciones.

## Principios

1. **Diario, no en vivo.** Un job programado (mismo patrón que el push de las 07:00) basta. No hay websocket, no hay refresh intradía, no hay gateway local de trading.
2. **Solo lectura.** Credenciales con el permiso mínimo posible. Olbia nunca coloca órdenes.
3. **Evidencia.** Guardar la respuesta cruda (JSON/XML) cifrada en S3, como con los MIME y CSVs; el parseo es revisable.
4. **Valorar en MXN** en el snapshot (o guardar moneda nativa + tipo de cambio usado) para unificar el resumen.
5. **Fallos visibles.** Si Bitso o IBKR fallan un día, se conserva el último snapshot bueno y se alerta; no se inventa saldo.

## Fuentes

### Bitso (primero — API simple)

- REST privada con API key + secret (HMAC).
- Endpoint clave: `GET /api/v3/balance/` → saldos por moneda (`available` / `locked` / `total`).
- Tickers públicos para convertir crypto → MXN el día del sync.
- Docs: [Get Account Balance](https://docs.bitso.com/bitso-api/docs/get-account-balance).

Credenciales en Secrets Manager. Permisos de la key: solo consulta, sin trading ni retiros si Bitso lo permite separar.

### Interactive Brokers (después — Flex Web Service)

Para un dashboard diario **no** usar Client Portal Gateway ni la Web API de trading en vivo. Usar **Flex Web Service**:

- Token + Flex Query ID → reporte XML (posiciones abiertas, cash, NAV, trades si hace falta).
- Sin gateway Java, sin sesión de browser, sin OAuth institucional.
- Latencia típica **T+1**: perfecto para “cuánto tengo hoy”, insuficiente para intradía (y no lo necesitamos).

Setup una vez en Client Portal:

1. Performance & Reports → Flex Queries → Flex Web Service: activar y generar token.
2. Crear Activity Flex Query con al menos: Account Information, Open Positions, Cash Report / Cash Transactions (según lo que se quiera mostrar).
3. Anotar Query ID; guardar token en Secrets Manager (rotación periódica).

Referencias: [Enable Flex Web Service](https://www.ibkrguides.com/clientportal/performanceandstatements/flex-web-service.htm), [IBKR Web API overview](https://www.interactivebrokers.com/campus/ibkr-api-page/web-api-trading/).

## Diseño de datos (borrador)

Unidades conceptuales (nombres provisionales):

- **WealthAccount** — institución + alias (`bitso`, `ibkr`, …).
- **WealthSnapshot** — un día (`YYYY-MM-DD`), cuenta, valor total en MXN (y/o USD), moneda base, puntero a evidencia cruda en S3.
- **WealthHolding** (opcional por snapshot) — símbolo/moneda, cantidad, precio de valuación, valor.

Persistencia alineada con V1: DynamoDB para metadatos e índices por día/cuenta; S3 + KMS para el payload crudo.

Importes: enteros en unidades menores + ISO 4217, igual que el dominio de gasto.

## Arquitectura propuesta

```text
EventBridge Scheduler (diario, p. ej. 06:30 America/Chihuahua)
  └─ Lambda wealth-sync
       ├─ Bitso: balance + tickers → holdings + total MXN
       ├─ IBKR: Flex SendRequest → poll GetStatement → parse XML
       ├─ S3: evidencia cruda cifrada
       ├─ DynamoDB: snapshot + holdings del día
       └─ (opcional) alarma / correo si falla una fuente
```

UI (más adelante): sección de patrimonio en Resumen o tab propio — total, desglose por cuenta, última actualización. No sustituye “Has gastado / Te quedan”; convive.

## Orden de implementación

1. Doc + decisión de alcance (este archivo).
2. Modelo DynamoDB + sync **solo Bitso** + snapshot en API + UI mínima de total.
3. Flex Query IBKR + parser XML + misma forma de snapshot.
4. Resumen unificado (patrimonio + gasto del mes) y, si aporta, push diario con patrimonio.

Fuera de alcance de esta fase: trading, alertas de precio, Plaid / Open Banking, bancos sin API (salvo import manual/CSV más adelante).

## Relacionado

- [Decisiones de V1](v1-decisions.md) — gasto observado; este plan es dominio aparte.
- [Arquitectura](architecture.md)
- [Push diario del balance](daily-balance-push.md) — patrón de scheduler diario a reutilizar.
- [Dirección de producto y UI](ui-design-brief.md) — aplicar antes de cualquier pantalla nueva.
