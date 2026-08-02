# Cobros manuales (eventos observados)

## Problema

Hoy el gasto entra solo por automatismos: correo (Amex, Santander, AWS), Apple Pay Shortcut y CSV Santander. Si un cobro no llega por esas vías —por ejemplo una compra Amex sin alerta, un cargo en una tarjeta sin parser, o un gasto que el usuario necesita contar ya— el total del mes queda incompleto.

Eso rompe la promesa del producto: **cuánto he gastado este mes**.

## Qué no es

| Concepto existente | Rol | Por qué no sirve aquí |
| --- | --- | --- |
| **Pago próximo** (`PlannedPayment`) | Compromiso futuro que reduce “Te quedan” | No es gasto observado; no suma a “Has gastado” |
| **Conciliar CSV Santander** | Respaldo masivo con evidencia de extracto | Solo Santander; exige archivo; no cubre un cargo Amex suelto |
| **Correo por revisar** | Recuperar fallos de parser | El problema es ausencia de fuente automática, no un MIME fallido |

Un cobro manual es un **movimiento observado** creado por el usuario. Entra al ledger, afecta el total del mes y conserva evidencia de que fue capturado a mano.

## Decisión de producto

1. **Misma unidad primaria:** `ObservedPurchase`. No inventamos “ajuste”, “asiento” ni “cobro” como entidad aparte.
2. **Nueva fuente de captura:** `captureSource: "manual"`.
3. **Aparece en Movimientos** y suma a “Has gastado” (salvo `rejected`).
4. **No abre un tercer destino de navegación.** La acción vive en Movimientos, junto a “Conciliar CSV”.
5. **El usuario es la autoridad:** un alta manual nace como `accepted`. No bloqueamos el total con “por confirmar” solo por ser manual.
6. **Evidencia obligatoria del acto:** se persiste un payload inmutable de lo que el usuario envió (JSON en S3, cifrado con KMS), más una observación `manual` en DynamoDB. La fuente no se reescribe; las correcciones son revisiones auditables.
7. **Reconciliación con automatismos posteriores:** si más tarde llega el mismo cobro por correo (u otra fuente), se enlaza como observación del evento existente cuando la coincidencia sea única y de alta confianza; si es ambigua, se deja separado o se pide decisión explícita. Nunca se borra la observación manual.
8. **Sin backfill histórico masivo en esta entrega.** El flujo es cargo por cargo (o pocos cargos recientes del mes en curso), alineado con “iniciar desde el lanzamiento”.

## Experiencia (móvil primero)

### Entrada

En **Movimientos**, acción secundaria al mismo nivel que “Conciliar CSV”:

- Etiqueta: **Registrar cobro**
- No compite con el total del mes en Resumen.
- No usa tarjetas decorativas ni pasos de “wizard” innecesarios.

### Sheet: “Registrar cobro”

Eyebrow: `FUERA DE AUTOMATISMO`  
Título: `Registrar cobro`

Campos (mínimos, en este orden):

1. **Institución** — selector con las instituciones ya conocidas (`american_express_mx`, `santander_mx`, `nu_mx`, `amazon_web_services`). Default sugerido: Amex si es el hueco más frecuente; el usuario puede cambiarlo.
2. **Comercio** — texto libre → `merchantRaw`.
3. **Cantidad** — misma convención de dinero que pagos e ingreso (mostrar pesos; persistir minor units + `MXN`).
4. **Fecha del cobro** — día del mes en curso (o fecha completa); se guarda como `occurredAt` en UTC con zona `America/Chihuahua`.
5. **Tarjeta (opcional)** — últimos cuatro / alias → `account.lastFour` / `displayName`.
6. **Nota (opcional)** — por qué se captura a mano; queda en el payload de evidencia, no como comercio.

CTA único: **Sumar al mes**.

Copy firme y útil, sin tono bancario:

- Ayuda corta: “Úsalo cuando el cobro no llegó por correo ni por CSV.”
- Tras guardar: el movimiento aparece en la lista; Resumen recalcula “Has gastado”, ritmo y “Te quedan” como con cualquier otro evento aceptado.

### Detalle del movimiento

En `EventSheet`, la fuente se etiqueta con claridad:

- Eyebrow / línea de origen: **Registro manual**
- Se puede ver la evidencia (JSON del alta: campos enviados, `createdAt`, usuario).
- No hay MIME de correo; no fingimos que hubo alerta.

### Edición y descarte

- Corregir importe, comercio o fecha → **revisión auditable** (mismo principio que V1: la observación original no se reescribe).
- “No cuenta” → pasar a `rejected` (ya excluido del total en UI). Preferible a borrar: conserva trazabilidad.
- Fuera de alcance inmediato si complica la primera entrega: edición completa en UI. Mínimo viable: alta + rechazo. La edición puede seguir en una iteración.

## Modelo y API

### Dominio

Extender:

```ts
type CaptureSource = "email" | "apple_pay_shortcut" | "santander_csv" | "manual";
```

Nuevo puntero de fuente (paralelo a Apple Pay / CSV):

```ts
interface ManualEntrySourcePointer {
  readonly kind: "manual_entry";
  readonly bucket: string;
  readonly key: string;
  readonly sha256: string;
  readonly contentType: "application/json";
}
```

El evento:

- `eventType`: `card_purchase` (default) o el que corresponda (`card_charge` solo si el usuario elige un cargo tipo AWS; en el MVP basta `card_purchase`).
- `status`: `accepted`
- `parserVersion`: p. ej. `manual-entry-v1`
- `parseWarnings`: vacío
- `receivedAt` / `ingestedAt`: momento del alta
- `occurredAt`: fecha que indicó el usuario
- `captureSource` / `captureSources`: incluye `"manual"`

### Persistencia

Patrón ya usado por CSV / correo:

| Pieza | Clave / lugar |
| --- | --- |
| Evento | `EVENT#{id}` / `EVENT` |
| Observación | `EVENT#{id}` / `OBSERVATION#{ts}#{obsId}` con `captureSource: manual` |
| Evidencia | S3 `manual-entries/{owner}/{sha}.json` (KMS) |
| Idempotencia | `DEDUPE#MANUAL#{fingerprint}` — ver abajo |

### Endpoint

```http
POST /events/manual
Authorization: Cognito JWT
```

Cuerpo (borrador):

```json
{
  "institution": "american_express_mx",
  "merchantRaw": "Amazon MX",
  "amountMinor": 129900,
  "currency": "MXN",
  "occurredAt": "2026-08-01T18:00:00.000Z",
  "accountLastFour": "1234",
  "note": "No llegó el correo de Amex"
}
```

Respuesta: el `ObservedPurchase` creado (misma forma que `GET /events`).

Opcional en la misma entrega o justo después:

```http
PATCH /events/{id}
```

ampliado para `reject` (hoy solo marca verificado), con revisión auditable.

### Fingerprint e idempotencia

No deduplicar solo por “importe + comercio + fecha” a ciegas en el alta (la política V1 del correo evita eso entre mensajes). Para **reenvíos del mismo formulario** (doble tap, retry de red):

`fingerprint = sha256(owner + institution + occurredAt(day) + amountMinor + normalize(merchantRaw) + accountLastFour?)`

- Mismo fingerprint en ventana corta → devolver el evento existente (idempotente).
- No usar ese fingerprint para fusionar con correo automáticamente; la fusión es **reconciliación**, no dedupe de alta.

### Reconciliación con correo posterior (Amex u otro)

Cuando llega una observación automática:

1. Buscar candidatos del mismo usuario/institución con misma fecha (día local), mismo `amountMinor` y comercio normalizado comparable.
2. **Una coincidencia** que ya tenga observación `manual` y ninguna automática equivalente → enlazar la nueva observación al evento; actualizar `captureSources`.
3. **Varias coincidencias** → no fusionar; dejar eventos separados o excepción `ambiguous_duplicate` / decisión explícita (mismo espíritu que CSV Santander).
4. El total del mes no debe contar dos veces el mismo gasto.

La UI puede mostrar en el detalle: “Registro manual · también correo” cuando haya más de una fuente.

## Impacto en Resumen

Sin cambios de jerarquía:

1. Has gastado ↑  
2. A este ritmo se recalcula  
3. Te quedan ↓  
4. No suma a “por confirmar” (status `accepted`)  
5. Aparece en la lista de movimientos debajo  

No añadir chips, stats ni CTAs en el hero de Resumen.

## Alcance de la primera entrega

**Incluye**

- `CaptureSource` + puntero `manual_entry`
- `POST /events/manual` + evidencia S3 + observación
- Sheet “Registrar cobro” en Movimientos
- Listado y detalle con origen manual
- Tests de dominio/API del alta e idempotencia básica

**Fuera (siguiente)**

- Importación masiva / CSV Amex
- Edición rica de campos en UI (más allá de rechazo)
- Foto o PDF adjunto como evidencia
- Alta de instituciones arbitrarias fuera del catálogo actual
- Tratar pagos/abonos negativos como en el CSV Santander

## Criterios de listo

- Un cobro Amex (u otra institución) capturado a mano aparece el mismo día en Movimientos y mueve “Has gastado”.
- La evidencia del alta es recuperable.
- Un doble envío no crea dos gastos.
- Si después llega el correo del mismo cobro, no se duplica el total cuando la coincidencia es única.
- La voz y la navegación siguen `docs/ui-design-brief.md` y `apps/web/AGENTS.md`: dos destinos, móvil primero, sin lenguaje bancario corporativo.

## Alternativas descartadas

1. **Meterlo como pago próximo** — distorsiona “Te quedan” y nunca explica el gasto real.
2. **Solo nota / campo libre en el mes** — pierde trazabilidad por movimiento y rompe Movimientos.
3. **CSV Amex primero** — útil como respaldo, pero el dolor inmediato es un cargo suelto sin archivo; el formulario es el camino corto y reutiliza el modelo de evento.
4. **Tercer tab “Captura”** — viola el modelo de dos destinos.
