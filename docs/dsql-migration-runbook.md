# DSQL: proyección, verificación y recuperación

Esta entrega implementa la primera fase de [dsql-migration-plan.md](dsql-migration-plan.md), con carga histórica y comparación por registro. DynamoDB continúa como autoridad de escrituras y lecturas de Olbia. No se elimina ni reemplaza la tabla ni se cambian sus índices, stream `NEW_IMAGE`, TTL, cifrado, PITR de 35 días o retención. No hay cambios de UI ni promoción de lecturas/escrituras a DSQL.

## Alcance e inventario

| Origen | Proyección SQL | Escritores existentes cubiertos por Streams |
| --- | --- | --- |
| `EVENT#id / EVENT` | `movements`, `movement_tags`, `msi_plans`, `msi_installments` | Ingesta de correo y Apple Pay; captura manual; imports CSV, estados de cuenta, conciliación USD/MXN y MSI; ediciones individuales; apply/undo masivo; categorías; herramientas del asistente |
| `EVENT#id / OBSERVATION#…` | `movement_observations` | Capturas, importaciones y conciliación |
| `EVENT#id / REVISION#…` | `movement_revisions` | Mutaciones, categorías y apply/undo; operation IDs se conservan en payload |
| `CATEGORY_CATALOG / CAT#id` | `categories` | Catálogo persistido, superpuesto a `DEFAULT_SPEND_CATEGORIES` del dominio |
| `CATEGORY_RULES / RULE#merchant` | `merchant_category_rules` | Reglas humanas, seed y asistente |
| `USER#owner / CARD#id` | `cards` | Perfiles de corte/pago y eliminación de tarjeta |

Claims de dedupe, operaciones masivas como entidad independiente, fuentes/recibos de ingesta, excepciones, planificación mensual, push, conversaciones y Patrimonio permanecen en DDB y están fuera de esta proyección. S3 conserva toda evidencia original. No se infiere una relación `card_id` a partir de nombre, banco o últimos cuatro; la cuenta observada queda en el payload del movimiento.

Los IDs string existentes, moneda, importe bancario, Mi parte (incluido cero), estados y campos opcionales se conservan. Los importes son `bigint` en unidades menores; los agregados usan strings decimales para evitar pérdida de precisión. El mes financiero usa `America/Chihuahua`. Las fechas de cuota `occurredOn` tienen tipo `date`, y los instantes `timestamptz`. Cada checkpoint conserva el envelope completo del origen en `source_item`; los payloads JSONB conservan evidencia, warnings y atributos aún sin columna.

## Decisiones nativas y huecos concretos

- Cluster regional nativo `AWS::DSQL::Cluster`, protegido contra borrado y con `RETAIN`, en `us-east-2`.
- Conector oficial `@aws/aurora-dsql-node-postgres-connector`: tokens IAM por conexión, TLS verificado, pool de dos conexiones, vida máxima de cinco minutos, timeout de conexión diez segundos, timeout de consulta en el cliente veinte segundos (sin parámetros de timeout en el handshake PostgreSQL) y retry OCC acotado. No contraseñas almacenadas ni admin en projector, mantenimiento o replay.
- DSQL no ofrece un recurso CloudFormation que ejecute DDL o asocie roles SQL con IAM. Un Provider de CDK ejecuta DDL aditivo y reanudable, crea `olbia_projector`, concede permisos únicamente sobre la proyección y asocia los roles IAM. Espera los índices nativos `CREATE INDEX ASYNC` consultando `sys.jobs` y `pg_index.indisvalid`, incluyendo builds ya iniciados sin nuevo `job_id`; aplica retry OCC acotado a cada sentencia autocommit y prueba conexión/lectura con el rol SQL de runtime. El mapping depende de este bootstrap. `Delete` es un no-op: nunca ejecuta `DROP` ni borra datos.
- DynamoDB Streams → segundo lector Lambda. El lector de retries existente conserva su configuración. Este es el segundo lector por shard; no añadir un tercero sin revisar la cuota nativa. No reserved concurrency.
- Reintentos, bisect, fallos parciales, edad máxima seis horas, diez intentos y destino S3 nativo del mapping. El bucket privado tiene KMS, versionado y retención sin borrado automático. El binding de S3 concede `PutObject` en todos los objetos de ese bucket y `ListBucket`, sin el `DeleteObject` que concede el helper genérico de CDK. La validación nativa del destino requiere alcance `bucket/*`; limitar la escritura a `aws/lambda/*` impide crear el mapping aunque sea el prefijo utilizado para entregas. El permiso de escritura conserva la condición `s3:ResourceAccount` para esta cuenta; replay sólo lee `aws/lambda/*`.
- Step Functions y EventBridge Scheduler coordinan reconciliación paginada después del despliegue y cada día. No outbox, cola adicional ni archivo personalizado de cada evento.
- Métricas nativas de Lambda, mapping y Step Functions; alarmas de errores, throttles, edad > cinco minutos, registros fallidos, entregas/fallos de S3 y reconciliación fallida/expirada. SNS dirige alarmas al `AlertRecipientEmail` existente. **Confirmar la suscripción SNS recibida por email** para activar su entrega; revisar este paso después del merge.

## Protocolo de orden y concurrencia

Todos los disparadores, incluyendo backfill y replay, usan la misma operación por PK/SK:

1. Abrir una transacción SQL y leer el checkpoint del origen. Esa lectura establece el snapshot antes de leer DDB.
2. Leer el item actual de DDB con `ConsistentRead=true`. Nunca usar NewImage del stream o una imagen histórica como contenido para escribir SQL.
3. Validar y transformar. Actualizar siempre la generación del checkpoint, incluso si el hash no cambió; conservar un tombstone si el item ya no existe.
4. En la misma transacción, reemplazar solamente las filas asociadas a esa PK/SK. Para movimientos, reemplazar también tags y calendario MSI; no borrar observaciones/revisiones de otras SK.
5. Commit. El conector reintenta la transacción completa ante OCC (`40001`, `OC000`, `OC001`); cada intento vuelve a leer SQL y DDB. La carrera inicial de dos inserts puede producir `23505`; sólo la constraint `projection_state_pkey` tiene retry adicional, con máximo tres reintentos. Los demás errores no se interpretan como concurrencia.

Si A observa un estado antiguo y B escribe uno nuevo primero, ambos modifican el mismo checkpoint: A aborta por conflicto y vuelve a leer DDB. Si A empieza después del commit de B, su lectura consistente de DDB no puede recuperar un estado anterior al observado por B. Esto también cubre eliminaciones, recreaciones, splits de shard, bootstrap y replay tardío sin una versión común en los escritores. No se usan timestamps aproximados ni sequence numbers como orden total.

`stream_arn`, `stream_sequence` y `stream_delivered_at` son evidencia del último disparador de stream aplicado a esa clave; **no son una versión global ni la frontera de toda la tabla**. Un replay antiguo vuelve a leer contenido actual y puede actualizar esta evidencia. Las generaciones de SQL son locales a cada PK/SK.

Cada transacción de movimiento limita la proyección a 900 filas y 4 MiB de filas nuevas, dejando margen para borrar el agregado anterior, guardar el envelope y permanecer debajo de 3.000 modificaciones / 10 MiB. Datos inválidos fallan sin modificar la última proyección válida y terminan en recuperación nativa.

Una transacción DDB multi-item puede aparecer separada/intercalada en SQL. La proyección converge por item; no promete una transacción financiera global entre motores. Por eso sigue fuera de las lecturas del producto y no hay FKs que requieran padres ficticios o borren historial en cascada.

## Carga histórica, reconciliación y paridad

La máquina `personal-finance-v1-dsql-reconciliation` tiene cuatro pasadas:

1. `source`: scan paginado **de claves** (25 items por página) y reconciliación con lectura consistente del estado actual; también incorpora defaults efectivos de categorías.
2. `target`: recorrer checkpoints SQL y consultar DDB para reparar borrados que no llegaron por Streams.
3. `verify-source`: verificar todos los items del alcance en el origen y acumular conteos/importes por mes y moneda.
4. `verify-target`: verificar también claves ausentes del origen y categorías por defecto. Guardar conteos por tabla SQL y comparar agregados de importe bancario y Mi parte por mes/moneda con los del origen. Estos son totales de todos los estados observados, **no gasto aceptado ni saldo del producto**.

El scan no es un snapshot global ni una carga masiva de payloads. Se elige para el volumen personal acotado y porque la garantía de orden exige volver a leer DDB dentro de la transacción SQL. Export PITR/loader oficial no transforma el modelo ni resuelve versiones incomparables; importar sus imágenes directamente sería inseguro. Si el volumen crece, usar export PITR únicamente para enumerar claves y conservar este protocolo de reconciliación. Los items borrados se recuperan recorriendo el destino. El coste inicial supone una tabla personal pequeña: medir páginas, reads de DDB y DPUs reales después de activar; no se consultó producción desde esta sesión.

La comparación usa un snapshot SQL y dos lecturas consistentes de DDB. Distingue `lag` (hash diferente, versión de transformador diferente o fuente que cambió durante comparación) de `mismatch` (mismo hash/checkpoint y filas relacionales distintas). Compara todas las columnas, payloads, relaciones y ausencia/presencia; no sólo IDs o conteos. Un agregado que cambia durante la pasada se clasifica como lag. El job sólo termina `SUCCEEDED` con cero lag y cero mismatch; si hubo actividad concurrente, volver a ejecutar cuando converja.

El progreso por ejecución queda en `s3://<DsqlRecoveryBucket>/reconciliation/<sha256-del-arn-de-ejecución>/progress.json`; versiones anteriores quedan retenidas. Incluye fase, cursor, conteos, `checkedAt`, agregados y evidencia de stream. El cursor identifica la siguiente página; los retries de una página pueden repetir trabajo sin duplicar entidades o acumular dos veces los contadores devueltos. Los totales financieros permanecen privados en AWS: Actions imprime sólo estado y contadores de verificación.

La verificación de cada clave y los agregados son evidencia de paridad observada durante esas pasadas, no una barrera atómica entre DDB/SQL. Ni un job correcto ni su cantidad de checkpoints prueban que se observaron **todas** las modificaciones intermedias durante una brecha de Streams. La reconstrucción recupera el estado actual y las observaciones/revisiones aún retenidas en DDB.

## Despliegue y aceptación

Sólo PR → `quality` → merge aprobado en main → `deploy-production`. No desplegar CDK o Lambdas desde la sesión ni escribir DDB para provocar eventos. El workflow verifica identidad con STS, lee los outputs del stack, renueva la sesión AWS de verificación, inicia la máquina desplegada y espera hasta 50 minutos (el job nativo puede continuar hasta cuatro horas); un fallo hace fallar `deploy-production` aunque CloudFormation ya haya terminado. Esto no revierte DDB ni promueve SQL.

Outputs: `DsqlEndpoint`, `DsqlRecoveryBucket`, `DsqlReconciliationArn`, `DsqlReplayFunction`, `DsqlEventSourceMapping`, `DsqlAlertsTopic`.

Antes de afirmar que octubre está acumulándose en SQL, comprobar:

- CloudFormation y smoke IAM/schema exitosos; mapping Enabled con procesamiento correcto.
- Ejecución post-deploy `SUCCEEDED`, report privado con `lag=0` y `mismatch=0`, todos los meses históricos y cuotas futuras incluidos.
- Evidencia de stream en los checkpoints de operaciones realizadas por las capturas/ediciones normales del producto después de habilitar el mapping. Revisar también `IteratorAge`, `FailedInvokeEventCount`, entregas S3 y alarmas.
- Suscripción SNS confirmada. Si la activación fue posterior al inicio de octubre, la pasada completa de claves incluye sus movimientos ya persistidos.

La sesión de implementación no tiene AWS configurado. Las pruebas PostgreSQL y synth locales no prueban IAM, cuotas ni comportamiento del motor DSQL real; el bootstrap y job post-deploy proporcionan esa verificación por el mecanismo aprobado. No se declara activación productiva antes del merge/despliegue y de estas evidencias.

## Recuperación de un rollback de creación

El despliegue de #145 falló en bootstrap y dejó cluster, bucket y seis log groups retenidos fuera del template activo. El siguiente `deploy-production` sintetiza las definiciones revisadas y ejecuta `infrastructure/scripts/recover-dsql-resources.py` **antes** del diff/deploy normal. El script usa importación nativa CloudFormation; no es una segunda vía de despliegue local.

1. Verifica identidad/cuenta y estado estable del stack. Lee su template activo y eventos `DELETE_SKIPPED` de recursos `DsqlProjection` ausentes del template.
2. Agrega únicamente cluster/bucket/log groups retenidos. Conserva intactos recursos, outputs y parámetros anteriores; nunca importa ni modifica DDB. Identidades ambiguas o dependencias ajenas bloquean el rollout.
3. Usa los roles CDK de deploy/file publishing que el rol GitHub ya puede asumir. Sube el template al bucket privado de assets; valida identificadores mediante `get-template-summary` y crea un change set `IMPORT` con parámetros anteriores y el execution role existente.
4. Comprueba que todas las acciones sean `Import` y exactamente los recursos esperados. Ejecuta la importación, espera `IMPORT_COMPLETE` y verifica sus IDs físicos. Después continúa el CDK normal y la verificación histórica. Una repetición omite recursos ya administrados.

No borrar los recursos retenidos ni crear reemplazos para esquivar conflictos de nombres. Si una importación falla, revisar el change set/eventos nativos en AWS; el job se detiene y no continúa al deploy. Tras `IMPORT_ROLLBACK_COMPLETE`, el siguiente rollout aprobado puede volver a intentar. Si hay múltiples IDs físicos para un mismo logical ID, resolver la selección mediante una corrección revisada, conservando la evidencia.

La recuperación de #146 falló porque `GetTemplate` convirtió caracteres Unicode en `?`: el template descargado parecía idéntico, pero CloudFormation detectaba cambios en descripciones y schemas existentes y rechazaba el import. Para este rollout, el script recupera del bucket CDK el artefacto original del último despliegue exitoso (`4b7dec2e3164baca19e6564f242c2347d2612b4e48ac55cb7494ab4a52c6eae6.json`), verifica su SHA-256 y exige que cada recurso/sección original coincida con el stack vivo, permitiendo únicamente esa pérdida de Unicode. Usa el original para conservar los valores reales; no los adivina desde código nuevo. Cualquier diferencia adicional detiene la recuperación. Recursos ya importados siguen omitiéndose. El preview nativo de esta corrección confirmó ocho acciones `Import`, ninguna modificación de aplicación; sólo `deploy-production` ejecuta la importación.

Bootstrap versión 2 informa la etapa y un código permitido, por ejemplo `admin-connect (28000)`, `schema-statement-3 (0A000)` o `runtime-connect-and-smoke (28000)`. No incluye mensajes/detail del driver ni valores financieros. La llamada anterior `SELECT sys.wait_for_job` era incorrecta: DSQL la ofrece como procedimiento, con `CALL`; ahora se consulta estado/readiness nativos. El error original del primer rollout fue descartado, así que no se afirma que ese defecto fuera su causa exacta. El nuevo rollout debe confirmar importación, bootstrap y paridad reales.

## Operación y recuperación

Para diagnóstico local autorizado: `aws login` y verificar `aws sts get-caller-identity` inmediatamente antes de cada operación de producción. Usar la cuenta `225989371926`, región `us-east-2`. No usar llaves permanentes ni publicar reportes/payloads privados en Git o logs públicos.

Leer outputs y revisar mapping con APIs de sólo lectura:

```bash
aws sts get-caller-identity
aws cloudformation describe-stacks --stack-name PersonalFinanceV1 --region us-east-2 --query 'Stacks[0].Outputs'
aws lambda get-event-source-mapping --uuid '<DsqlEventSourceMapping>' --region us-east-2
```

Repetir carga/verificación con la capacidad desplegada (no es un despliegue):

```bash
aws sts get-caller-identity
aws stepfunctions start-execution --state-machine-arn '<DsqlReconciliationArn>' --input '{}' --region us-east-2
aws stepfunctions describe-execution --execution-arn '<executionArn>' --region us-east-2
```

Si una ejecución se interrumpe, conservar/revisar su reporte privado y reanudar iniciando otra ejecución con ese JSON como `--input file://progress.json` (fase distinta de `done`). La máquina acepta fase, cursor, contadores y `sourceTotals`. Un reporte `done` con lag/mismatch requiere una pasada nueva completa, no reanudar su última página. Step Functions también permite redrive nativo de ejecuciones fallidas; para fallos de paridad, hacer una ejecución nueva desde `source`.

La comparación conserva milisegundos de `timestamptz`: pg devuelve objetos Date y se normalizan directamente con `toISOString()`. Convertirlos primero con `String()` descartaba esa precisión y causaba discrepancias falsas en movimientos/revisiones. La regresión usa el parser nativo de pg y sigue rechazando diferencias reales de un milisegundo; no se reduce precisión ni se omiten columnas para aprobar paridad.

Para una falla S3, listar objetos del prefijo `aws/lambda/` del bucket de recuperación y pasar su clave al replay desplegado:

```bash
aws sts get-caller-identity
aws lambda invoke --function-name '<DsqlReplayFunction>' --region us-east-2 --cli-binary-format raw-in-base64-out --payload '{"key":"aws/lambda/<mapping>/<shard>/<date>/<object>"}' replay-result.json
```

Revisar `FunctionError` y `replay-result.json`; si falla, el objeto original sigue intacto. Lambda usa `payload` (JSON escapado) para el batch completo en S3; el replay recupera sus claves y relee DDB. Repetir es seguro. Después del replay, ejecutar reconciliación/paridad. No borrar manualmente objetos para silenciar alarmas.

Una avería prolongada puede perder la ventana de 24 horas de Streams antes de invocar siquiera Lambda; el destino S3 no cubre esos eventos. La reconciliación diaria recorre **ambos motores** y restaura el estado actual, incluidos borrados. Una brecha bloquea cualquier futura promoción de lecturas hasta reconstrucción, cero discrepancias y evidencia de captura normal.

Para pausar captura, cambiar `captureEnabled` a `false` en `infrastructure/lib/dsql-projection.ts` mediante una PR y el workflow aprobado; no llamar `update-event-source-mapping` manualmente. La reconciliación diaria continúa reparando el espejo. Para detener también mantenimiento, cambiar/deshabilitar su Schedule mediante PR. Para reactivar, volver a `captureEnabled = true` por PR y repetir verificación completa; tras >24h no confiar solamente en replay. DDB sigue disponible durante fallos o pausas de SQL.

Rollback de código conserva cluster, tablas SQL, recovery y DDB; el Delete del bootstrap no destruye datos. Las migraciones futuras deben ser aditivas/versionadas, incrementando la propiedad Version del bootstrap y aplicando DDL explícito para columnas nuevas. No modificar una tabla con `CREATE TABLE IF NOT EXISTS` y asumir que eso migra su estructura. No ejecutar DDL de reparación manual en producción: entregar la reparación por PR.

## Validación local y siguiente fase

`quality` incluye tests, checks de ledger/web/infraestructura, build web y synth. Las pruebas usan PostgreSQL embebido (PGlite) para ejecutar SQL real, el wrapper de transacciones oficial con conflictos forzados, y un modelo OCC para intercalaciones adversas. Cubren idempotencia, replay tras commit perdido, rollback parcial, tombstones, snapshot/carga concurrente, tags/MSI obsoletos, evidencia, defaults y paridad. Los tests de infraestructura comparan el recurso DDB antes/después, retención, orden del bootstrap, límites IAM, recuperación y alarmas con acciones.

Después de verificar esta fase con datos reales, continuar con consultas de comparación del contrato API (detalle/listados/resumen), latencia y `EXPLAIN ANALYZE VERBOSE`; luego promover rutas reversibles y resolver lectura después de escritura. Cambiar la autoridad de escrituras requiere la decisión posterior y réplica SQL→DDB del plan. No hay eliminación de DynamoDB en esta entrega.

Fuentes oficiales verificadas: [conector Node](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/SECTION_program-with-dsql-connector-for-node-postgres.html), [roles IAM/SQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/authentication-authorization.html), [SQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-sql-features.html), [tipos JSONB/bigint](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-data-types.html), [OCC](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-concurrency-control.html), [índices async](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-create-index-async.html), [recuperación Streams/S3](https://docs.aws.amazon.com/lambda/latest/dg/services-dynamodb-errors.html), [métricas del mapping](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html).

Referencias de recuperación: [importación manual](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/import-resources-manually.html), [tipos compatibles con importación](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-supported-resources.html), [catálogo/jobs DSQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-systems-tables.html).
