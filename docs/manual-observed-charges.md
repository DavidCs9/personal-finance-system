# Cobros manuales (eventos observados)

Referencia del flujo **enviado**: registrar un cobro observado cuando no llegó por correo, Apple Pay, CSV ni estado de cuenta.

## Problema

El gasto entra por automatismos (correo Amex/Santander/Nu/AWS, Apple Pay, CSV Santander, PDF Amex/Santander). Si un cobro no llega por esas vías, el total del mes queda incompleto.

## Qué no es

| Concepto existente | Rol | Por qué no sirve aquí |
| --- | --- | --- |
| **Pago próximo** (`PlannedPayment`) | Compromiso futuro que reduce “Te quedan” | No es gasto observado; no suma a “Has gastado” |
| **Conciliar CSV / estado PDF** | Respaldo masivo con evidencia de extracto | Exige archivo; no cubre un cargo suelto sin documento |
| **Correo por revisar** | Recuperar fallos de parser | El problema es ausencia de fuente automática, no un MIME fallido |

Un cobro manual es un **movimiento observado** creado por el usuario. Entra al ledger, afecta el total del mes y conserva evidencia de que fue capturado a mano.

## Decisiones de producto

1. **Misma unidad primaria:** `ObservedPurchase`. No hay entidad “ajuste” aparte.
2. **Fuente:** `captureSource: "manual"`.
3. **Aparece en Movimientos** y suma a “Has gastado” (salvo `rejected`).
4. **Sin tercer tab.** La acción vive en Movimientos bajo **Añadir**.
5. **Autoridad del usuario:** nace como `accepted`.
6. **Evidencia:** JSON inmutable en S3 (KMS) + observación `manual` en DynamoDB.
7. **Reconciliación posterior:** si llega el mismo cobro por correo (u otra fuente) con coincidencia única, se enlaza; si es ambigua, queda separado. Nunca se borra la observación manual.
8. **Sin push** al crear el alta manual (el aviso de “movimiento nuevo” es solo correo / Apple Pay).
9. **Amex auto-MSI:** importe **> $2,500.00** abre plan `amex_auto` de 3 meses al crear el evento, igual que el correo.

## Experiencia (móvil primero)

### Menú Añadir

En **Movimientos**, **Añadir** abre el sheet **Sumar un movimiento** (`CAPTURAR`) con:

| Acción | Uso |
| --- | --- |
| **Registrar cobro** | Cargo suelto sin automatismo |
| **Conciliar CSV Santander** | Respaldo y cuotas A MESES |
| **Estado de cuenta Santander** | PDF del periodo (Textract) |
| **Estado de cuenta Amex** | PDF del periodo (Textract) |

“Ordenar” permanece fuera del menú (control de vista).

### Sheet: Registrar cobro

Eyebrow: `FUERA DE AUTOMATISMO`  
Título: `Registrar cobro`  
CTA: **Sumar al mes**

Campos: institución → comercio → cantidad → fecha → tarjeta (opcional) → nota (opcional).

Copy: “Úsalo cuando el cobro no llegó por correo ni por CSV.”

### Detalle

En `EventSheet`: origen **Registro manual**; evidencia JSON recuperable; sin MIME.

### Edición y descarte

- “No cuenta en el mes” → `PATCH` con `action: reject` (preferible a borrar).
- Edición rica de campos en UI: fuera de alcance; alta + rechazo es el mínimo enviado.

## Modelo y API

### Dominio

```ts
type CaptureSource =
  | "email"
  | "apple_pay_shortcut"
  | "santander_csv"
  | "manual"
  | "amex_statement"
  | "santander_statement";
```

```ts
interface ManualEntrySourcePointer {
  readonly kind: "manual_entry";
  readonly bucket: string;
  readonly key: string;
  readonly sha256: string;
  readonly contentType: "application/json";
}
```

- `eventType`: `card_purchase` (o `card_charge` cuando aplique)
- `status`: `accepted`
- `parserVersion`: `manual-entry-v1`
- `captureSource` / `captureSources`: incluye `"manual"`

### Persistencia

| Pieza | Clave / lugar |
| --- | --- |
| Evento | `EVENT#{id}` / `EVENT` |
| Observación | `EVENT#{id}` / `OBSERVATION#{ts}#{obsId}` |
| Evidencia | S3 `manual-entries/{owner}/{sha}.json` (KMS) |
| Idempotencia | `DEDUPE#MANUAL#{fingerprint}` (permanente; sin TTL) |

### Endpoint

```http
POST /events/manual
Authorization: Cognito JWT
```

`occurredOn` (`YYYY-MM-DD`) es **requerido** si no hay `occurredAt` válido; con ambos, `occurredOn` define el día de calendario local.

```json
{
  "institution": "american_express_mx",
  "merchantRaw": "Amazon MX",
  "amountMinor": 129900,
  "currency": "MXN",
  "occurredOn": "2026-08-01",
  "accountLastFour": "1234",
  "note": "No llegó el correo de Amex"
}
```

Respuesta: el `ObservedPurchase` creado.

```http
PATCH /events/{id}
```

con `action: reject` para “No cuenta en el mes”.

### Fingerprint e idempotencia

`fingerprint = sha256(owner + institution + occurredOn + amountMinor + normalize(merchantRaw) + accountLastFour?)`

- Mismo fingerprint → devolver el evento existente (idempotente frente a doble tap / retry).
- No fusiona con correo: eso es **reconciliación**.

### Reconciliación con correo posterior

1. Candidatos mismo owner/institución, mismo día local, mismo `amountMinor`, comercio comparable.
2. Una coincidencia con observación `manual` y sin automática equivalente → enlazar.
3. Varias → no fusionar (mismo espíritu que CSV).
4. El total del mes no cuenta dos veces el mismo gasto.

## Impacto en Resumen

Sin cambios de jerarquía: Has gastado ↑, ritmo y Te quedan se recalculan; no suma a “por confirmar”; aparece en Movimientos. Sin CTAs extra en el hero de Resumen.

## Fuera de alcance (backlog)

- Edición rica de campos en UI (más allá de rechazo)
- Foto o PDF adjunto como evidencia del alta manual
- Instituciones fuera del catálogo actual
- Tratamiento de abonos negativos como en el CSV Santander

(Los PDF Amex/Santander ya están en el menú Añadir; no son backlog de este flujo.)

## Criterios de listo

- Un cobro capturado a mano aparece el mismo día en Movimientos y mueve “Has gastado”.
- La evidencia del alta es recuperable.
- Un doble envío no crea dos gastos.
- Si después llega el correo del mismo cobro, no se duplica el total cuando la coincidencia es única.
- Voz y navegación siguen `docs/ui-design-brief.md` y `apps/web/AGENTS.md`.
