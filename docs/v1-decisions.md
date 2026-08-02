# Decisiones de V1

## Objetivo y alcance

- Capturar automáticamente compras con tarjeta notificadas por email de American Express México y Santander México, y pagos Santander observados por una automatización de Apple Pay.
- Iniciar desde el lanzamiento; no hay backfill histórico en V1.
- Un correo válido crea un evento observado y aceptado. La verificación manual no bloquea su aparición en el ledger.
- Los casos ambiguos se guardan para revisión y nunca se convierten en una compra por inferencia.

## Fuente y trazabilidad

- Las alertas se reenvían automáticamente desde el correo principal a `alertas@inbound.finance.castrodavid.dev`.
- Amazon SES recibe el correo, conserva el MIME en S3 y activa la ingesta; no se usa OAuth ni una cuenta de Gmail dedicada.
- La deduplicación identifica el mismo mensaje o reenvío exacto mediante identidad de origen y hash; no deduplica por importe, comercio y fecha.
- La fuente MIME/RFC 822 se guarda antes de parsear, cifrada con KMS en S3 y retenida indefinidamente.
- DynamoDB conserva metadatos, hash y el puntero al objeto fuente.
- Apple Pay es una fuente adicional y nunca sustituye al correo. Cada ejecución conserva una observación inmutable autenticada con una credencial exclusiva del Shortcut.
- La idempotencia se aplica por fuente. La reconciliación puede vincular observaciones de fuentes distintas, pero no elimina ninguna de ellas.
- La UI permite previsualizar y aplicar manualmente el CSV de movimientos de tarjeta Santander. El archivo original se conserva cifrado en S3 como evidencia.
- La identidad `tarjeta + consecutivo` evita repetir operaciones entre CSVs. Las filas sin consecutivo usan fecha, concepto normalizado, importe y ordinal de aparición dentro del extracto, y siempre exigen confirmación explícita antes de su primera importación.
- La conciliación del CSV compara tarjeta, fecha, importe y concepto normalizado contra observaciones de correo o Apple Pay. Una coincidencia única enlaza el CSV como evidencia del evento existente; múltiples coincidencias exigen una decisión explícita antes de aplicar.
- Los pagos y abonos negativos del CSV no se incorporan al gasto mensual.
- Los cobros que no llegan por automatismo (p. ej. Amex sin alerta) se registran como eventos observados con fuente `manual`, no como pagos próximos. Detalle en [Cobros manuales](manual-observed-charges.md).
- MSI (meses sin intereses) vive en el evento observado como `msi` (schedule multi-mes). No se guarda en `MonthlyPlan`.
- Amex con importe **> $2,500.00** asume 3 MSI al crear el evento (`amex_auto`); el usuario puede overridear meses/cuota en la UI.
- El ciclo de cada cuota es `committed` → `spent` (nunca ambos). Hasta reconciliar, la cuota resta de “Te quedan” vía dinero comprometido; al confirmar evidencia pasa a “Has gastado”.
- Evidencia MSI: CSV Santander con conceptos tipo `A MESES`, estado de cuenta Amex (PDF→texto en cliente), y estado de cuenta Santander (PDF imagen → Amazon Textract async → parseo en API). Coincidencia con tolerancia de $2.00; gana el monto del estado.
- Una cuota del estado sin plan previo crea un MSI `statement_unplanned` que exige completar N meses/cuota.
- Liquidación anticipada de MSI es manual (cancelar cuotas restantes + registrar el cargo de cierre si aplica).
- El PDF de estado Santander es imagen: `POST /imports/santander-statement/preview` sube el PDF, arranca Textract y responde `processing`; el cliente hace poll a `GET …/{importId}` hasta `ready` y luego `POST …/apply`. El CSV de movimientos sigue disponible como respaldo.

## Modelo de datos

- La unidad primaria es un evento observado, no una transacción contable definitiva.
- Un evento puede agregar varias observaciones. Sólo se reconcilian automáticamente coincidencias únicas de alta confianza; los casos ambiguos permanecen separados.
- Cada evento se asocia a una institución y a una cuenta/tarjeta explícita, usando solo alias o últimos cuatro dígitos cuando estén disponibles.
- Los importes usan enteros en unidades menores y códigos ISO 4217.
- Se conservan `occurred_at`, `received_at` e `ingested_at` en UTC. La UI se presenta inicialmente en `America/Chihuahua`.
- En V1, el comercio se conserva únicamente como `merchant_raw`.
- Las correcciones son revisiones auditables: la fuente y el parseo original no se reescriben.
- `ObservedPurchase.msi` es opcional y contiene origen, principal, cuota, meses e installments con status por mes.

## Infraestructura

- Toda la infraestructura vive en AWS, en `us-east-2`, definida con CDK y TypeScript.
- Se usa la cuenta personal de AWS y tags consistentes para atribuir costes.
- DynamoDB bajo demanda es la base de datos operativa.
- La UI es una SPA de React en S3 + CloudFront. La API es API Gateway HTTP API + Lambdas con autorización JWT de Cognito.
- Cognito tiene un único usuario administrado, sin registro público y sin MFA por ahora.
- Una regla de recepción de SES guarda primero el MIME y luego publica su puntero en SQS; una Lambda de ingestión persiste metadatos, deduplica y parsea. La cola tiene una DLQ.
- Amazon SES sólo alerta excepciones de ingestión (parser fallido, origen no soportado, datos incompletos). Los movimientos aceptados no generan correo.
- Si el usuario activó Web Push, el alta de un evento nuevo (correo o Apple Pay) envía un aviso al dispositivo, y cada mañana a las 07:00 America/Chihuahua se envía el resumen diario. Detalle en [Avisos push de movimientos observados](push-on-new-observable.md) y [Push diario del balance](daily-balance-push.md).
- El monitoreo V1 se limita a fallos de recepción, mensajes en DLQ, errores persistentes de ingestión y fallos del push diario.
- Ninguna Lambda usa concurrencia reservada. Los endpoints públicos limitan tráfico en API Gateway para conservar la concurrencia compartida de la cuenta.

## Calidad y salida de V1

- Los parsers se prueban con fixtures `.eml` anonimizadas y fieles a los formatos reales; los correos reales no se versionan.
- V1 está lista cuando los flujos de ambos bancos capturan una compra una sola vez, conservan su fuente, avisan por push si está activo, la muestran en UI y hacen recuperables los fallos de parser.
