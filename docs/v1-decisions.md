# Decisiones de V1

## Objetivo y alcance

- Capturar automáticamente compras con tarjeta notificadas por email de American Express México, Santander México y transferencias Nu, más cargos de facturación AWS, y pagos Santander observados por una automatización de Apple Pay.
- Registrar cobros sin automatismo como eventos observados manuales; conciliar CSV Santander y estados de cuenta PDF (Amex / Santander vía Textract).
- Derivar el ingreso del mes desde CFDIs de nómina (XML); con un solo recibo ordinario en el mes en curso, estimar la segunda quincena.
- Mostrar patrimonio neto (activos − saldos pendientes de tarjeta): Cajita Nu manual, Fondo de ahorro derivado de SAT `004`, Bitso e IBKR por sync programado.
- Recordar días de corte y pago de hasta tres tarjetas (perfil en Resumen; saldo pendiente en Patrimonio).
- Iniciar desde el lanzamiento; no hay backfill histórico de producto en V1 (scripts operativos bajo `infrastructure/scripts/` no son el camino de usuario).
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
- MSI (meses sin intereses) vive en el evento observado como `msi` (schedule multi-mes). No se guarda en `MonthlyPlan`. Guía completa: [Meses sin intereses (MSI)](msi.md).
- Amex con importe **> $2,500.00** asume 3 MSI al crear el evento (`amex_auto`); el usuario puede overridear meses/cuota en la UI. Aplica a correo y a alta manual.
- Compras Amex Gold cubiertas por `MONTO A DIFERIR MESES EN AUTOMÁTICO` quedan en status `deferred_msi`: visibles en Movimientos, fuera de “Has gastado”; solo cuenta la cuota del plan auto.
- El ciclo de cada cuota es `committed` → `spent` (nunca ambos). Hasta reconciliar, la cuota resta de “Te quedan”; al confirmar evidencia pasa a “Has gastado”. En Resumen, “Planes con fin” lista las cuotas del mes; Movimientos muestra la lista raw con badge `MSI i/N`.
- Evidencia MSI y conciliación: CSV Santander (respaldo / movimientos), y estados Amex/Santander vía Textract **AnalyzeDocument** (`QUERIES` + `TABLES`). El estado es el path preferido para abrir planes (trae `i/N` y total). Santander PDF enriquece cuotas desde la tabla de planes (`12M`, `03 DE 12`, etc.).
- Una cuota del estado sin plan previo **no inventa** un schedule sola: queda `needs_decision`. Apply: `create_plan`, confirmar en plan existente, u omitir. Si la fila ya trae `n/N` completo, omitir **crea el plan** con esa metadata (incluye etiquetas Amex “MESES EN AUTOMÁTICO”).
- Liquidación anticipada de MSI es manual (cancelar cuotas restantes + registrar el cargo de cierre si aplica).
- PDF de estado (Amex y Santander): `POST /imports/amex/preview` o `POST /imports/santander-statement/preview` → poll `GET` → `POST …/apply` con decisiones. Se persiste `.textract.json` y el apply reconstruye desde ese JSON.
- Ingreso del mes: `POST /imports/nomina` (XML CFDI) + `GET /months/:month` (payslips + estimado/provisional). `PUT /months/:month` solo guarda `upcomingPayments`. Cuando el mes no tiene registro propio, `GET` hereda la lista del último mes anterior sin escribir; el siguiente cambio materializa la lista completa en el mes seleccionado.
- Patrimonio: ver [Patrimonio](patrimonio.md). Tarjetas de ciclo: `GET|PUT|DELETE /cards/{cardId}` (máximo 3).

## Modelo de datos

- La unidad primaria es un evento observado, no una transacción contable definitiva.
- Un evento puede agregar varias observaciones. Sólo se reconcilian automáticamente coincidencias únicas de alta confianza; los casos ambiguos permanecen separados.
- Cada evento se asocia a una institución y a una cuenta/tarjeta explícita, usando solo alias o últimos cuatro dígitos cuando estén disponibles.
- Los importes usan enteros en unidades menores y códigos ISO 4217.
- Se conservan `occurred_at`, `received_at` e `ingested_at` en UTC. La UI se presenta inicialmente en `America/Chihuahua`.
- En V1, el comercio se conserva únicamente como `merchant_raw`.
- Las correcciones son revisiones auditables: la fuente y el parseo original no se reescriben.
- `ObservedPurchase.msi` es opcional y contiene origen, principal, cuota, meses e installments con status por mes.
- Snapshots de patrimonio (`WEALTH_SNAP#`, `LIAB_SNAP#`) y payslips de nómina viven en la misma MetadataTable.

## Infraestructura

- Toda la infraestructura vive en AWS, en `us-east-2`, definida con CDK y TypeScript.
- Se usa la cuenta personal de AWS y tags consistentes para atribuir costes.
- DynamoDB bajo demanda es la base de datos operativa.
- La UI es una SPA de React en S3 + CloudFront. La API es API Gateway HTTP API + Lambdas con autorización JWT de Cognito.
- Cognito tiene un único usuario administrado, sin registro público y sin MFA por ahora. El login web está personalizado para ese propietario.
- Una regla de recepción de SES guarda primero el MIME y luego publica su puntero en SQS; una Lambda de ingestión normaliza MIME con `mailparser`, deduplica y usa los parsers deterministas conocidos como fast path.
- Si un correo de una institución conocida no coincide o falla su parser, una cola aislada invoca Claude Haiku 4.5 en Bedrock con JSON Schema. La salida sólo se acepta cuando validadores deterministas comprueban institución, tipo, monto, estado, fecha/hora y evidencia literal. La cola de fallback tiene DLQ y alarmas propias.
- La identidad de fuente (`Message-ID` + SHA-256) no cambia entre retries. Las excepciones se deduplican aparte por fuente y versión del extractor, y un intento fallido nunca consume permanentemente el claim del movimiento.
- Amazon SES sólo alerta excepciones de ingestión (parser fallido, origen no soportado, datos incompletos) y fallos de sync Bitso/IBKR. Los movimientos aceptados no generan correo.
- Si el usuario activó Web Push, el alta de un evento nuevo (correo o Apple Pay) envía un aviso al dispositivo; cada mañana a las 07:00 America/Chihuahua el resumen diario; a las 07:05 los recordatorios de corte/pago. Detalle en [Avisos push de movimientos observados](push-on-new-observable.md), [Push diario del balance](daily-balance-push.md) y [Push de corte y pago](card-cycle-push.md).
- Sync de patrimonio: Bitso 06:30 y IBKR 06:45 America/Chihuahua, con DLQ y alarmas.
- El monitoreo V1 cubre fallos de recepción, mensajes en DLQ, errores persistentes de ingestión, errores/DLQ del fallback Bedrock, fallos del push diario/card-cycle, y fallos/DLQ de sync Bitso e IBKR.
- Ninguna Lambda usa concurrencia reservada. Los endpoints públicos limitan tráfico en API Gateway para conservar la concurrencia compartida de la cuenta.

## Calidad y salida de V1

- Los parsers y validadores Bedrock se prueban con fixtures `.eml` anonimizadas y fieles a los formatos reales; los correos reales no se versionan. Antes de promover un extractor se replayan las fuentes cifradas de S3 y se comparan sus campos sin imprimir PII.
- V1 está lista cuando los flujos de captura conservan su fuente, avisan por push si está activo, muestran gasto y patrimonio en UI, y hacen recuperables los fallos de parser y de sync.
