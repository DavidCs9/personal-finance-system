# Visibilidad completa (gasto + ingreso + patrimonio)

## Estado

**Plan / parcialmente fuera de V1.** Olbia ya observa el **gasto** (Amex, Santander, Apple Pay). Este documento fija el resto del mapa para **full visibility**: capturar **todos** los ingresos (XML de la empresa) y el **patrimonio** (Cajita Nu, Bitso, IBKR), sin datos en vivo ni complejidad de trading.

## Objetivo

Que Olbia sea el único lugar donde consultar lo financiero:

| Dominio | Hoy (V1) | Futuro |
| --- | --- | --- |
| Gasto del mes | Amex / Santander / Apple Pay → eventos observados | sin cambio de modelo |
| **Ingreso** | Una cifra manual en el plan del mes (suma de dos depósitos) | **Cada XML de la empresa** → ingreso observado con evidencia; el mes se deriva de eso |
| Patrimonio | — | Cajita Nu + Bitso + IBKR → snapshots diarios |

No mezclar unidades:

- Un **gasto** o **ingreso** observado es un evento con evidencia (como hoy las compras).
- Un **snapshot** de patrimonio es un saldo/posición de un día, no una compra.

Nu crédito / SPEI de V1 ≠ saldo de Cajita. La Cajita es solo patrimonio (fondo de emergencia).

## Principios

1. **Full visibility.** Si la empresa manda un XML de ingreso, Olbia lo captura **siempre** — nómina ordinaria, aguinaldo, bono, ajuste, lo que sea. No se deja fuera “porque ya puse el total a mano”.
2. **Evidencia primero.** El XML (o el MIME que lo trae) se guarda cifrado en S3 antes de parsear; el parseo es revisable y no reescribe la fuente.
3. **Diario, no en vivo** para patrimonio automatizable. Ingreso entra cuando llega el XML (evento), no por poll intradía.
4. **Solo lectura** donde haya API de broker/exchange. Olbia no opera ni mueve dinero.
5. **Fallos visibles.** Parser fallido o fuente caída: alerta y último estado bueno; no inventar cifras.
6. **Roles explícitos en patrimonio.** Fondo de emergencia ≠ invertible.

## Ingresos — XML de la empresa

### Situación actual

- El ingreso del mes es **manual**: un solo `incomeMinor` en `MonthlyPlan` (la UI pide el total de los dos depósitos de nómina).
- No hay evidencia del depósito ni desglose por pago.

### Situación deseada

La empresa **manda XML de todos los ingresos**. Eso es la fuente canónica.

- Cada XML produce un **ingreso observado** (unidad análoga a compra observada: institución, fecha, importe neto a pagar / percibido, tipo si se puede inferir, puntero a evidencia).
- El **ingreso del mes** en Resumen = suma de ingresos observados aceptados de ese mes calendario (sustituye o alimenta el total manual).
- Mientras el parser o el mes no estén listos, el total manual sigue siendo fallback; nunca se inventa ingreso por proyección.

### Captura prevista

Mismo espíritu que las alertas de tarjeta:

```text
Empresa → correo (o adjunto) con XML
  → reenvío / filtro a alertas@inbound…  (o upload en UI)
  → SES + S3 (XML/MIME cifrado)
  → ingestión: dedupe + parse → ingreso observado
  → UI: aparece en el mes; alimenta “ingreso configurado”
```

Detalle a fijar cuando haya un XML real de muestra:

- Esquema exacto (p. ej. CFDI nómina u otro XML interno de la empresa).
- Campo de importe que cuenta para “lo que entra al mes” (neto vs bruto; Olbia debe ser explícita).
- Idempotencia: UUID fiscal / UUID del comprobante / hash del XML.
- Filtro de Gmail: reenviar **todos** los XML de ingreso, no solo la nómina quincenal.

Hasta tener fixture: no asumir tags; el plan exige capturar el archivo completo y versionar el parser.

### Relación con el plan del mes

- V1 UI/brief: ingreso = una cifra editable.
- Futuro: esa cifra se **deriva** de los XML del mes; la edición manual queda como override o corrección auditable, no como única fuente.
- Dos depósitos quincenales = dos (o más) XML → dos eventos → suma = ingreso del mes.

## Patrimonio — cuentas conocidas

| Cuenta | Rol | Moneda | Sync previsto |
| --- | --- | --- | --- |
| **Cajita Nu** | Fondo de emergencia | MXN | Manual (sin API retail pública) |
| **Bitso** | Crypto / efectivo en exchange | varias → MXN | API REST diaria |
| **IBKR** | Inversiones broker | USD (+ FX a MXN) | Flex Web Service diario |

### Cajita Nu — fondo de emergencia

- Apartado de Cuenta Nu de Débito ([Cajitas Nu](https://blog.nu.com.mx/productos-nu/cuenta-nu/que-son-las-cajitas-de-cuenta-nu/)).
- Sin API pública retail → entrada manual de snapshot (`nu_mx:cajita_emergencia`, nombre provisional).
- Solo cuenta lo apartado en la Cajita de emergencia, no el saldo de débito disponible.
- “Stale” en UI si no se actualizó en N días.

### Bitso

- `GET /api/v3/balance/` + tickers públicos → MXN.
- Key solo lectura en Secrets Manager.
- Docs: [Get Account Balance](https://docs.bitso.com/bitso-api/docs/get-account-balance).

### Interactive Brokers — Flex Web Service

- No Client Portal Gateway ni trading en vivo.
- Token + Flex Query → XML (posiciones, cash, NAV).
- Latencia T+1; suficiente para dashboard diario.
- Refs: [Flex Web Service](https://www.ibkrguides.com/clientportal/performanceandstatements/flex-web-service.htm), [Web API](https://www.interactivebrokers.com/campus/ibkr-api-page/web-api-trading/).

## Diseño de datos (borrador)

**Ingreso (evento):**

- `ObservedIncome` (provisional) — fecha, importe, moneda, empleador/fuente, tipo opcional, `source` (`employer_xml` | `manual`), puntero S3, dedupe id.
- Agregación mensual → alimenta o reemplaza `MonthlyPlan.incomeMinor`.

**Patrimonio (snapshot):**

- `WealthAccount` — institución + alias + rol (`emergency_fund` | `brokerage` | `crypto` | …).
- `WealthSnapshot` — día, cuenta, valor MXN, origen (`api` | `manual` | `flex`), evidencia.
- `WealthHolding` opcional por snapshot.

Importes: enteros en unidades menores + ISO 4217.

## Arquitectura propuesta

```text
Ingreso (cuando llega)
  Empresa XML → SES/S3 → Lambda ingestión → ObservedIncome → mes

Patrimonio (diario, p. ej. 06:30 America/Chihuahua)
  EventBridge → Lambda wealth-sync
       ├─ Bitso API
       ├─ IBKR Flex
       ├─ Cajita Nu: último manual
       └─ DynamoDB + evidencia S3

UI
  Resumen: Has gastado / Te quedan (gasto) + ingreso del mes desde XML
         + bloque patrimonio (emergencia / Bitso / IBKR)
```

## Orden de implementación

1. Doc de alcance (este archivo).
2. **Ingreso XML:** fixture real → parser + evidencia + lista en mes + derivar total del mes (fallback manual).
3. Modelo patrimonio + **entrada manual Cajita Nu** + UI mínima.
4. Sync **Bitso**.
5. **IBKR** Flex.
6. Resumen unificado y, si aporta, push (patrimonio / Cajita stale / ingreso nuevo).

Fuera de alcance de esta fase: trading, scraping app Nu, Open Banking forzado, asumir esquema XML sin muestra.

## Relacionado

- [Decisiones de V1](v1-decisions.md)
- [Arquitectura](architecture.md)
- [Reenvío Gmail → SES](gmail-forwarding.md) — mismo canal candidato para XML de ingreso.
- [Push diario del balance](daily-balance-push.md)
- [Ciclo de tarjeta](card-cycle-push.md) — Nu crédito ≠ Cajita.
- [Dirección de producto y UI](ui-design-brief.md) — actualizar la regla de “ingreso solo manual” cuando se implemente XML.
