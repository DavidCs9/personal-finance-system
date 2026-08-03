# Patrimonio diario (Bitso + IBKR + Cajita Nu)

## Estado

**Plan / no implementado.** Este documento fija el alcance futuro: un dashboard de ahorros e inversiones que se actualiza **una vez al día**, sin datos en vivo y sin APIs de trading complejas. La V1 de Olbia (gasto con tarjeta) no cambia.

## Objetivo

Que Olbia sea, a la larga, el lugar donde consultar **todo** lo financiero: gasto del mes **y** patrimonio (fondo de emergencia, crypto, broker, efectivo).

Dos dominios distintos:

| Dominio | Hoy (V1) | Futuro |
| --- | --- | --- |
| Gasto del mes | Amex / Santander / Apple Pay → eventos observados | sin cambio |
| Patrimonio | — | Cajita Nu + Bitso + IBKR (+ otras cuentas después) → snapshots diarios |

No mezclar: un snapshot de Bitso no es un “evento observado” de compra. El modelo de gasto permanece; patrimonio es un ledger aparte de saldos y posiciones.

Nu ya aparece en V1 por **tarjeta de crédito** (ciclo de corte/pago) y por alertas SPEI de la cuenta; eso no es el saldo de la Cajita. La Cajita es ahorro apartado y entra solo en patrimonio.

## Cuentas conocidas

| Cuenta | Rol | Moneda | Sync previsto |
| --- | --- | --- | --- |
| **Cajita Nu** | Fondo de emergencia | MXN | Manual (sin API retail pública) |
| **Bitso** | Crypto / efectivo en exchange | varias → MXN | API REST diaria |
| **IBKR** | Inversiones broker | USD (+ FX a MXN) | Flex Web Service diario |

## Principios

1. **Diario, no en vivo.** Un job programado (mismo patrón que el push de las 07:00) basta para fuentes automatizables. No hay websocket, no hay refresh intradía, no hay gateway local de trading.
2. **Solo lectura** donde haya API. Credenciales con el permiso mínimo posible. Olbia nunca coloca órdenes ni mueve dinero.
3. **Evidencia.** Guardar la respuesta cruda (JSON/XML) o el registro de entrada manual cifrado en S3 cuando aplique; el parseo es revisable.
4. **Valorar en MXN** en el snapshot (o guardar moneda nativa + tipo de cambio usado) para unificar el resumen.
5. **Fallos visibles.** Si Bitso o IBKR fallan un día, se conserva el último snapshot bueno y se alerta; no se inventa saldo. La Cajita Nu se considera “stale” si el usuario no la actualizó hace N días.
6. **Roles explícitos.** El fondo de emergencia no se mezcla con “invertible”: en UI debe verse como liquidez de respaldo, no como rendimiento a perseguir.

## Fuentes

### Cajita Nu — fondo de emergencia

- Producto: apartado de la Cuenta Nu de Débito ([Cajitas Nu](https://blog.nu.com.mx/productos-nu/cuenta-nu/que-son-las-cajitas-de-cuenta-nu/)).
- Rol en Olbia: **fondo de emergencia** (liquidez líquida en MXN, con rendimiento de la Cajita; no es trading).
- **No hay API pública** para clientes retail que exponga el saldo de una Cajita. Open Finance / scraping de app quedan fuera de alcance.
- Sync previsto: **entrada manual** (o import ligero más adelante) que crea/actualiza un `WealthSnapshot` del día para la cuenta `nu_mx:cajita_emergencia` (nombre provisional).
- El saldo de débito “disponible” de Nu no es el fondo de emergencia; solo cuenta lo apartado en la Cajita designada.
- Si más adelante Nu u Open Finance ofrecen lectura oficial, se sustituye el manual por el mismo shape de snapshot.

### Bitso (API simple)

- REST privada con API key + secret (HMAC).
- Endpoint clave: `GET /api/v3/balance/` → saldos por moneda (`available` / `locked` / `total`).
- Tickers públicos para convertir crypto → MXN el día del sync.
- Docs: [Get Account Balance](https://docs.bitso.com/bitso-api/docs/get-account-balance).

Credenciales en Secrets Manager. Permisos de la key: solo consulta, sin trading ni retiros si Bitso lo permite separar.

### Interactive Brokers (Flex Web Service)

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

- **WealthAccount** — institución + alias + rol (`emergency_fund` | `brokerage` | `crypto` | …). Ejemplos: `nu_mx:cajita_emergencia`, `bitso`, `ibkr`.
- **WealthSnapshot** — un día (`YYYY-MM-DD`), cuenta, valor total en MXN (y/o USD), moneda base, origen (`api` | `manual` | `flex`), puntero a evidencia cruda en S3 si aplica.
- **WealthHolding** (opcional por snapshot) — símbolo/moneda, cantidad, precio de valuación, valor.

Persistencia alineada con V1: DynamoDB para metadatos e índices por día/cuenta; S3 + KMS para el payload crudo.

Importes: enteros en unidades menores + ISO 4217, igual que el dominio de gasto.

## Arquitectura propuesta

```text
EventBridge Scheduler (diario, p. ej. 06:30 America/Chihuahua)
  └─ Lambda wealth-sync
       ├─ Bitso: balance + tickers → holdings + total MXN
       ├─ IBKR: Flex SendRequest → poll GetStatement → parse XML
       ├─ Cajita Nu: no auto — se lee el último snapshot manual del día/cuenta
       ├─ S3: evidencia cruda cifrada (APIs)
       ├─ DynamoDB: snapshot + holdings del día
       └─ (opcional) alarma / correo si falla una fuente API

UI / API
  └─ POST manual de saldo Cajita Nu → WealthSnapshot del día
```

UI (más adelante): sección de patrimonio en Resumen o tab propio — total, desglose por cuenta (con etiqueta clara de fondo de emergencia), última actualización. No sustituye “Has gastado / Te quedan”; convive.

## Orden de implementación

1. Doc + decisión de alcance (este archivo), incluyendo Cajita Nu como emergencia.
2. Modelo DynamoDB + cuentas con rol + **entrada manual Cajita Nu** + UI mínima de total/desglose.
3. Sync **Bitso** automático + misma forma de snapshot.
4. Flex Query IBKR + parser XML.
5. Resumen unificado (patrimonio + gasto del mes) y, si aporta, push diario con patrimonio / aviso de Cajita stale.

Fuera de alcance de esta fase: trading, alertas de precio, scraping de la app Nu, Plaid / Open Banking forzado, otros bancos sin API (salvo el mismo patrón manual/CSV).

## Relacionado

- [Decisiones de V1](v1-decisions.md) — gasto observado; este plan es dominio aparte.
- [Arquitectura](architecture.md)
- [Push diario del balance](daily-balance-push.md) — patrón de scheduler diario a reutilizar.
- [Ciclo de tarjeta / push de corte](card-cycle-push.md) — Nu crédito ≠ Cajita ahorro.
- [Dirección de producto y UI](ui-design-brief.md) — aplicar antes de cualquier pantalla nueva.
