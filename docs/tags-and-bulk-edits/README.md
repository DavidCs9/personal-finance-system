# Tags y ediciones asistidas

Estado: implementado. Este documento describe el contrato vigente; producción sigue el flujo normal de pull request, `quality` y `deploy-production`.

## Objetivo

Permitir que una persona organice movimientos por contexto desde el chat sin editar cada movimiento ni confirmar otra vez en la UI, conservando evidencia, aislamiento por usuario y un historial auditable.

Ejemplos:

- “Pon `viaje:vegas` a todo del 21 al 25”.
- “Agrega `ciudad:cdmx` del 13 al 21”.
- “Deshaz ese cambio”.

Una instrucción explícita para agregar o quitar tags autoriza el lote completo. El agente no decide autónomamente escribir: ejecuta únicamente una petición de tags que el usuario acaba de expresar.

## Categorías y tags

- La categoría describe qué tipo de gasto fue.
- Los tags describen el contexto y pueden solaparse.
- Un movimiento conserva una categoría y hasta 20 tags normalizados.
- Los tags no cambian Has gastado, Te quedan, proyecciones, MSI, conciliación ni Patrimonio.
- La ruta directa del agente sólo permite tags. Las categorías conservan `propose_recategorize` y confirmación en la UI.

## Secuencia de una edición

1. El usuario pide explícitamente agregar o quitar tags e indica un rango.
2. El Harness llama `preview_tag_edit` directamente, sin consultar primero `list_movements`.
3. El backend selecciona sólo movimientos `accepted`, congela los IDs exactos y sus valores previos, y persiste una operación con TTL.
4. El Harness llama inmediatamente `apply_tag_edit(operationId)` en el mismo turno. No existe confirmación adicional en la UI.
5. Una transacción condicionada actualiza los movimientos, crea una revisión por movimiento y marca la operación como aplicada.
6. El chat emite un evento SSE `mutation`; la UI refresca el ledger y muestra conteo, importe, rango y tags cambiados.
7. Si el usuario pide deshacer, `undo_tag_edit(operationId)` restaura el snapshot mediante otra transacción condicionada.

Las fechas son inclusivas en la zona financiera. Los movimientos rechazados nunca se incluyen. Un lote tiene como máximo 49 movimientos para mantenerse dentro del límite de 100 acciones de una transacción DynamoDB.

## Modelo de datos y auditoría

Cada evento puede incluir:

```ts
tags?: readonly string[];
```

Los tags usan minúsculas, formato `nombre` o `namespace:valor`, máximo 48 caracteres, sin vacíos ni duplicados.

Cada operación persiste:

- `operationId` y dueño;
- rango y cambio normalizado;
- IDs, tags y categoría anteriores/siguientes congelados;
- conteo e importe;
- estado `pending`, `applied` o `undone`;
- expiración, aplicación y deshacer.

Cada movimiento actualizado recibe una revisión con el mismo `operationId`, `changedBy` igual al dueño configurado, `source=assistant_chat_tag_edit`, valores anteriores/nuevos y una razón legible.

Apply y undo son idempotentes. Un retry devuelve el estado ya alcanzado sin duplicar revisiones. Si un movimiento cambió después del preview, DynamoDB cancela todo el lote y obliga a generar un preview nuevo.

## Tools y límites de seguridad

El Harness dispone de tres tools en un Gateway de mutaciones separado:

| Tool | Contrato |
|------|----------|
| `preview_tag_edit` | Congela una operación tags-only para movimientos `accepted` dentro del rango |
| `apply_tag_edit` | Aplica exactamente el `operationId` generado por preview |
| `undo_tag_edit` | Deshace exactamente una operación aplicada |

La arquitectura mantiene varias defensas independientes:

- El chat Cognito sólo invoca el Harness si `claims.sub` coincide con `AgentOwnerSub`.
- La Lambda de mutación usa `AGENT_OWNER`; ninguna tool acepta un owner del modelo o del browser.
- El Gateway usa `AWS_IAM` y un Policy Engine nativo en modo `ENFORCE`.
- Cedar niega por defecto y sólo permite esas tres acciones al rol exacto del Harness.
- La Lambda de lectura no tiene permisos de escritura.
- La Lambda de mutación sólo lee la tabla y escribe claves `BULK_EDIT#<owner>` o `EVENT#*` mediante `PutItem`/`UpdateItem`.
- No existe una tool genérica de DynamoDB ni endpoints públicos `/bulk-edits`.
- No se registran payloads financieros completos sólo por observabilidad.

## UI

El sheet no muestra preview ni botón para confirmar tags. Al completarse la operación muestra un recibo corto y factual:

> Etiquetas actualizadas · 18 movimientos · $9,232.14
>
> 2026-08-21–2026-08-25 · Agregar viaje:vegas

El recibo indica que el cambio puede deshacerse por chat. Las propuestas de categoría mantienen su botón “Confirmar categoría”. Modo privado también oculta los importes del recibo.

## Criterios de aceptación

- Una petición explícita de tags ejecuta preview y apply en el mismo turno sin confirmación adicional.
- El preview congela el conjunto exacto antes de cualquier escritura.
- Sólo se modifican movimientos `accepted` dentro del rango inclusivo.
- Reintentar apply o undo no duplica revisiones ni invierte dos veces.
- El solapamiento de rangos conserva varios tags en un movimiento.
- Un conflicto posterior al preview cancela el lote entero.
- Categorías y reglas de comercio no cambian por estas tools.
- Ninguna mutación cruza usuarios ni puede llamarse desde un principal diferente al rol del Harness.
- La UI refresca sus lecturas y muestra el resultado sin pedir confirmación.

## Fuera de alcance

- Clasificación automática con un LLM.
- Nuevas categorías o subcategorías.
- Mutaciones distintas a tags desde el Gateway directo.
- Escritura sin una instrucción explícita del usuario.
- Cambios a la arquitectura de Resumen / Movimientos / Patrimonio.
- Deploy manual o escrituras directas a producción.
