# PR 1 — Tags y ediciones masivas asistidas

Estado: plan aprobado para implementación. Este documento no autoriza cambios directos en producción ni reemplaza el flujo de pull request y despliegue del repositorio.

## Goal

Permitir que una persona organice movimientos por contexto y aplique cambios masivos desde el asistente sin editar cada movimiento manualmente, conservando la evidencia financiera, el aislamiento por usuario y un historial auditable.

El primer caso de uso es:

- agregar `viaje:vegas` a los movimientos aceptados del 21 al 25 de agosto de 2026;
- agregar `ciudad:cdmx` a los movimientos aceptados del 13 al 21 de agosto de 2026;
- permitir que el 21 tenga ambos tags;
- mostrar una sola confirmación con el número de movimientos y el importe afectado;
- aplicar o deshacer la operación completa sin incluir movimientos rechazados.

PR 1 no implementa la categorización automática con LLM. Esa capacidad pertenece a PR 2.

## Decisiones de producto

### Categorías y tags tienen propósitos distintos

- La categoría describe **qué tipo de gasto fue**: Restaurantes, Transporte, Shopping, Viajes, etc.
- Los tags describen **en qué contexto ocurrió**: `viaje:vegas`, `ciudad:cdmx`, `trabajo:reembolso`, etc.
- Un movimiento conserva una sola categoría y puede tener varios tags.
- Los tags no cambian Has gastado, Te quedan, proyecciones, MSI, conciliación ni Patrimonio.
- Una edición masiva de categoría es posible, pero no crea reglas comercio→categoría automáticamente. Esto evita convertir, por ejemplo, todos los cargos futuros de Panda Express en Viajes.

### Escritura controlada desde el asistente

El asistente podrá iniciar una edición masiva, pero no ejecutará una mutación irreversible sólo porque el modelo la pidió.

1. El agente interpreta la solicitud y crea un preview determinista.
2. El backend resuelve y congela los IDs exactos de los movimientos afectados.
3. La UI muestra rango, filtros, cantidad, importe y cambios propuestos.
4. La persona confirma una sola vez desde la sesión autenticada con Cognito.
5. La API aplica la operación, registra una revisión por movimiento y devuelve el resultado.

La confirmación aplica al lote completo, no a cada movimiento individual.

### Semántica del rango

- Las fechas son inclusivas y usan la zona financiera vigente de Olbia.
- Por defecto sólo se seleccionan movimientos aceptados.
- Los rechazados nunca se incluyen.
- Los estados especiales se muestran por separado en el preview y requieren selección explícita si una operación futura decide soportarlos.
- El importe del preview usa la misma semántica de Movimientos y Resumen: Mi parte cuando existe y la cuota del mes para MSI.

## Modelo de datos

Cada evento podrá incluir:

```ts
tags?: readonly string[];
```

Reglas V1:

- tags normalizados en minúsculas;
- formato `nombre` o `namespace:valor`;
- sin tags vacíos ni duplicados;
- máximo 20 tags por movimiento;
- máximo 48 caracteres por tag;
- el orden no tiene significado financiero.

Cada operación masiva tendrá un `operationId` y persistirá:

- dueño autenticado;
- filtro y cambio solicitado;
- IDs y estado previo congelados;
- cantidad e importe del preview;
- fecha de creación y expiración;
- estado `pending`, `applied`, `undone` o `expired`;
- actor que confirmó y timestamps de aplicación/deshacer.

Los previews expirarán mediante TTL nativo de DynamoDB. La implementación debe habilitar TTL en la tabla existente sin renombrarla ni reemplazarla y verificarlo con `cdk diff`.

## Mutaciones auditables

La operación de dominio debe soportar en un mismo lote:

- `addTags`;
- `removeTags`;
- `categoryId` opcional;
- `updateMerchantRules: false` por defecto y obligatorio para categorías por rango.

Cada movimiento actualizado recibe una revisión con:

- valores anteriores y nuevos;
- `operationId` compartido;
- `changedBy` autenticado;
- origen `assistant_confirmed_bulk`;
- razón legible.

Aplicar y deshacer deben ser idempotentes. Un retry no puede duplicar revisiones ni invertir dos veces la misma operación. Si un movimiento cambió después del preview, la operación debe detenerse y pedir un preview nuevo en lugar de sobrescribir silenciosamente el cambio.

El lote V1 tendrá un máximo de 49 movimientos, compatible con una transacción de DynamoDB formada por un update, una revisión por movimiento y la actualización de estado de la operación. No se usarán scripts con escrituras directas a producción.

## API propuesta

### `POST /bulk-edits/preview`

Entrada conceptual:

```json
{
  "selection": {
    "fromDay": "2026-08-21",
    "toDay": "2026-08-25",
    "statuses": ["accepted"]
  },
  "change": {
    "addTags": ["viaje:vegas"]
  }
}
```

Devuelve `operationId`, expiración, conteo, importe, desglose por estado y una muestra de movimientos. El backend conserva la lista completa de IDs; el browser no decide qué registros actualizar.

### `POST /bulk-edits/{operationId}/apply`

Aplica exactamente el snapshot confirmado. Requiere JWT Cognito, dueño coincidente e idempotency key.

### `POST /bulk-edits/{operationId}/undo`

Restaura los valores previos guardados por la operación cuando no existe un cambio posterior incompatible.

### Lecturas

- Los eventos públicos incluyen `tags`.
- Movimientos admite filtro por uno o varios tags.
- Las consultas del asistente pueden agregar gasto por tag usando las mismas reglas de gasto mensual.

## Tools del asistente

Agregar una tool de preview, por ejemplo `preview_bulk_edit`, con selección por rango, estado, categoría y tags. La tool sólo puede crear una propuesta acotada al `AGENT_OWNER` y no puede aplicar cambios.

La confirmación se ejecuta a través de la API autenticada del ledger. La Lambda de tools conserva permisos generales de lectura y recibe sólo un `PutItem` condicionado al prefijo de propuestas `BULK_EDIT#`; no puede actualizar movimientos. La capacidad de aplicar o deshacer vive en la API de mutaciones y no en una operación DynamoDB genérica expuesta al modelo.

El evento SSE de propuesta debe incluir `operationId`, resumen, conteo, importe y expiración. Nunca debe incluir credenciales, payloads crudos ni instrucciones de acceso a DynamoDB.

## UI móvil

- Mostrar tags discretos en la lista de Movimientos sin competir con importe, comercio, categoría o estado.
- Permitir agregar y quitar tags desde el detalle de un movimiento.
- Añadir filtro por tag en Movimientos conservando la lista simple y ordenable.
- Mostrar el preview masivo dentro del sheet global del asistente.
- La confirmación debe decir, por ejemplo: “Agregar viaje:vegas a 18 movimientos · $9,232.14”.
- Mostrar estados de aplicando, aplicado, conflicto, expirado y deshecho con lenguaje corto y factual.
- Mantener evidencia y detalle de cada movimiento accesibles.

Esta decisión cambia la regla actual de “asistente sólo lectura”. En el mismo PR deben actualizarse `docs/ui-design-brief.md`, `apps/web/AGENTS.md` y `docs/ai-assistant.md` para permitir únicamente mutaciones explícitas, previsualizadas, confirmadas y auditables.

## Infraestructura y seguridad

- Reutilizar API Gateway, Cognito, Lambda y MetadataTable existentes.
- Preferir TTL nativo de DynamoDB para previews expirados.
- No renombrar constructs ni recursos con estado.
- Mantener el owner derivado del JWT en la API; nunca aceptar un owner enviado por el cliente.
- Validar todos los argumentos generados por el agente como datos no confiables.
- Separar la capacidad de lectura del Gateway de la mutación autenticada.
- No otorgar `dynamodb:*` ni exponer una tool genérica de update.
- No registrar payloads financieros completos sólo para observar la operación; usar IDs, conteos, duración, resultado y `operationId`.
- Toda producción se despliega exclusivamente mediante PR, check `quality` y el job `deploy-production` después de llegar a `main`.

## Plan de implementación

1. **Contrato de dominio**
   - Definir validación y normalización de tags.
   - Extender el evento público y los cálculos de rango sin alterar las cifras financieras.
   - Definir preview, operación, revisión, conflictos e idempotencia.

2. **Servicio de edición masiva**
   - Resolver rangos mediante el índice mensual existente.
   - Excluir rechazados y congelar los eventos seleccionados.
   - Persistir previews con expiración.
   - Aplicar y deshacer con condiciones de concurrencia y revisiones auditables.

3. **API autenticada**
   - Añadir endpoints de preview, apply y undo.
   - Añadir filtros por tag y tags en los eventos públicos.
   - Validar owner, límites, estados e idempotency key.

4. **Asistente**
   - Añadir `preview_bulk_edit` y su definición de Gateway.
   - Emitir la propuesta por SSE.
   - Mantener apply/undo fuera de la tool del modelo y dentro de la API Cognito.
   - Ajustar permisos IAM al mínimo necesario.

5. **UI móvil**
   - Renderizar y editar tags en Movimientos/EventSheet.
   - Añadir filtro por tag.
   - Añadir preview, confirmación, conflicto y undo al AssistantSheet.
   - Verificar modo privado y accesibilidad táctil.

6. **Documentación vinculante**
   - Actualizar las tres guías de producto/asistente con la nueva política de mutaciones confirmadas.
   - Documentar API, modelo y comportamiento de auditoría.

7. **Pruebas y entrega**
   - Unitarias de normalización, rangos, estados, revisiones e idempotencia.
   - Integración de preview/apply/undo y aislamiento por owner.
   - UI para éxito, expiración, conflicto, retry y modo privado.
   - Caso Vegas/CDMX, incluido el solapamiento del 21.
   - `quality`, synth/diff sin reemplazos y flujo de PR con historia lineal.

## Criterios de aceptación

- “Pon viaje:vegas a todo del 21 al 25” produce un preview exacto y no escribe antes de confirmar.
- Confirmar una vez aplica el tag a todos los movimientos elegibles y crea una revisión por movimiento.
- Reintentar apply devuelve el mismo resultado sin duplicar cambios.
- Deshacer restaura exactamente el estado previo o informa un conflicto sin sobrescribir cambios posteriores.
- El día 21 puede conservar simultáneamente los tags de CDMX y Vegas.
- Los rechazados no aparecen ni se modifican.
- Las categorías y reglas de comercio no cambian al agregar tags.
- Filtrar o consultar por tag usa Mi parte/MSI correctamente y no altera los totales de Resumen.
- Ninguna mutación puede cruzar usuarios.
- La UI funciona primero en viewport móvil y conserva la evidencia accesible.

## Fuera de alcance de PR 1

- Clasificación automática con Nova Micro u otro LLM.
- Backfill automático de categorías históricas.
- Nuevas categorías o subcategorías.
- Escritura autónoma sin preview y confirmación.
- Cambios a la arquitectura de tres tabs.
- Deploy manual o escrituras directas a DynamoDB.
