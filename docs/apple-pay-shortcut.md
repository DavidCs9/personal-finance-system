# Captura automática desde Apple Pay

Apple Pay es una fuente adicional de observaciones para compras Santander. No reemplaza los correos: cuando ambas fuentes describen la misma compra, el sistema conserva las dos observaciones y muestra un solo evento reconciliado.

## Datos de despliegue

CloudFormation publica dos outputs:

- `ApplePayCaptureUrl`: URL HTTPS que debe usar el Shortcut.
- `ApplePayCaptureSecretArn`: secreto que contiene el bearer token exclusivo del iPhone.

Después del despliegue, el token se obtiene una sola vez con un perfil autorizado:

```sh
aws secretsmanager get-secret-value \
  --secret-id <ApplePayCaptureSecretArn> \
  --query SecretString \
  --output text | jq -r .token
```

El token únicamente autoriza `POST /captures/apple-pay`; no concede lectura de eventos ni acceso a la aplicación web. Si un dispositivo o Shortcut deja de ser confiable, rota el secreto y actualiza la automatización.

## Automatización en Shortcuts

En el iPhone:

1. Abre **Shortcuts → Automation → New Automation → Transaction**.
2. En **When I tap**, selecciona únicamente la tarjeta Santander que se registrará.
3. Selecciona **Run Immediately** y desactiva **Notify When Run**.
4. Elige **New Blank Automation**. Mantén las acciones dentro de esta automatización; algunas versiones de iOS pierden el tipo `Transaction` al encadenar otro Shortcut.
5. Agrega **Generate UUID** y asígnalo a la variable `RequestId`.
6. Agrega una acción **Text** para cada propiedad. Inserta `Shortcut Input`, toca la variable y selecciona la propiedad indicada:
   - `AmountRaw`: `Amount`
   - `CurrencyRaw`: dentro de `Amount`, selecciona `Currency` / `Currency Code` (el nombre depende de la versión de iOS). El texto final debe ser `MXN` o `USD`.
   - `MerchantRaw`: `Merchant`
   - `CardRaw`: `Card or Pass`
   - `NameRaw`: `Name`
7. Agrega **Current Date** y **Format Date** con formato ISO 8601. Asígnalo a `OccurredAt`.
8. Agrega una acción **URL** con el valor de `ApplePayCaptureUrl`.
9. Agrega **Get Contents of URL** con método `POST`, body `JSON` y estos headers:
   - `Authorization`: `Bearer <token>`
   - `Content-Type`: `application/json`
   - `Idempotency-Key`: variable `RequestId`
10. Configura el body con valores de texto, no con el objeto `Transaction` completo:

```json
{
  "requestId": "<RequestId>",
  "amountRaw": "<AmountRaw>",
  "merchantRaw": "<MerchantRaw>",
  "cardRaw": "<CardRaw>",
  "nameRaw": "<NameRaw>",
  "occurredAt": "<OccurredAt>",
  "institution": "santander_mx",
  "currency": "<CurrencyRaw>"
}
```

La conversión previa a texto es intencional. `Amount` es un objeto especial de tipo `Currency Amount`, y algunas versiones de iOS lo serializan como cero cuando se introduce directamente en un diccionario JSON. **No dejes `currency` fija en `MXN`**: una compra en Estados Unidos llegaría con el numeral correcto pero etiquetado como pesos.

Una captura aceptada (no duplicada) dispara el mismo Web Push de movimiento nuevo que el correo, si **Avisos de Olbia** está activo.

## Respuesta

Una observación nueva devuelve `201`. Repetir el mismo `Idempotency-Key` devuelve `200` y el mismo evento sin crear otro:

```json
{
  "accepted": true,
  "eventId": "7d2f9e2b-...",
  "observationId": "e412b37e-...",
  "duplicate": false,
  "reconciled": true
}
```

## Reconciliación y atomicidad

Cada fuente tiene una reclamación idempotente propia. DynamoDB guarda en una sola transacción la reclamación, la observación inmutable y la creación o vinculación del evento.

Para compras nacionales, Apple Pay y email se vinculan automáticamente sólo cuando existe un único candidato con la misma institución, tipo, moneda, importe, comercio normalizado y una diferencia máxima de 30 minutos.

Para una compra en USD, la captura Apple Pay queda visible como **Esperando cargo MXN** y no suma en **Has gastado**. Cuando llega el correo Santander, el sistema busca una única autorización USD plausible de fecha cercana y comercio compatible, conserva las dos observaciones y promueve el evento existente al importe bruto posteado en MXN. La tolerancia de fecha cubre el desfase horario de un viaje. No consulta una tasa de cambio ni estima el gasto. Si hay varios candidatos, no infiere una coincidencia.

Repeticiones de la misma fuente con comercio e importe idénticos dentro de dos minutos se consideran reintentos defensivos incluso si iOS generó un UUID nuevo.

## Prueba inicial

La automatización Transaction requiere una compra real. Haz primero una compra pequeña con el iPhone desbloqueado y revisa:

- que la automatización termine sin error;
- que `Amount` y `Merchant` no lleguen vacíos;
- que un reintento con el mismo UUID no cree otro evento;
- que el correo posterior se agregue como segunda observación al mismo evento.

Los pagos desde Apple Watch y las compras Apple Pay dentro de apps o Safari deben verificarse por separado, porque el disparador Transaction no tiene la misma cobertura que un toque NFC hecho con el iPhone.
