# Asistente Olbia (AgentCore Harness)

Documento técnico del asistente de consultas financieras. Decisiones de producto viven en [`ui-design-brief.md`](ui-design-brief.md) y [`apps/web/AGENTS.md`](../apps/web/AGENTS.md).

## Norte

Un solo asistente: consultas ahora; asesor de decisión (“¿qué tan responsable…?”) después, como el mismo Harness con más tools.

## Arquitectura

```
SPA (JWT Cognito)
  → API Gateway REST API  POST /agent/chat  ← chat producto (SSE nativo)
    → Lambda agent-proxy (RESPONSE_STREAM)
      → SSM pointer → Bedrock Prompt Management (versión pineada)
      → AgentCore Harness (InvokeHarness + systemPrompt/model override)
        → AgentCore Gateway (MCP, AWS_IAM)
          → Lambda agent-tools (AGENT_OWNER) → DynamoDB + computeMonthSummary
          → AWS-managed Web Search Tool → resultados con citas
        → AgentCore Gateway de mutaciones (MCP, AWS_IAM + Policy ENFORCE)
          → Lambda agent-tag-mutations (AGENT_OWNER) → DynamoDB TransactWrite

SPA (JWT Cognito)
  → API Gateway HTTP API  ← resto del ledger
    → Lambda api / tools auxiliares
```

- El browser **nunca** habla con AgentCore.
- El chat de producto usa un API Gateway **REST** dedicado: `POST /agent/chat`, Lambda proxy y `ResponseTransferMode=STREAM`. El API HTTP se conserva para el ledger porque bufferiza respuestas Lambda.
- El SPA lee SSE con `fetch` + `ReadableStream`; no usa `EventSource` porque el endpoint requiere `Authorization: Bearer <Cognito ID token>`.
- El authorizer Cognito vive en API Gateway. La Lambda recibe `requestContext.authorizer.claims.sub`; no hay Function URL pública en la ruta de producto.
- CORS pertenece a este REST API y a las respuestas de la Lambda proxy. El origen permitido es el dominio web de Olbia; las respuestas de autorización 4xx/5xx también incluyen CORS.
- El loop del agente lo corre **Harness** (no un Converse manual en la Lambda).
- Claude Sonnet 4.6 usa adaptive thinking con esfuerzo `medium`. La Lambda lo pasa por `additionalParams.additionalModelRequestFields`, no configura `temperature` para este modelo y reserva al menos 4096 tokens totales para razonamiento y respuesta.
- Las tools viven detrás de **Gateway**: un target Lambda de solo lectura para finanzas, un Gateway separado para mutaciones de tags y el [conector administrado Web Search Tool](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connector-web-search-tool.html) para información pública con citas.
- Harness, Memory y el Gateway de Web Search corren en `us-east-1`, requerido por el conector. El Gateway financiero existente, su Lambda y DynamoDB permanecen juntos en `us-east-2`; el Harness conecta ambos Gateways.
- Code interpreter: **apagado**.
- Memoria de conversación: AgentCore Memory conserva eventos crudos por conversación durante 365 días y hechos/preferencias durables por separado, todo aislado por Cognito `sub`. Reutilizar el mismo `sessionId` restaura el contexto del Harness. Las estrategias personalizadas de largo plazo rechazan inferencias del asistente, cálculos intermedios, saldos actuales, unidades no confirmadas y fechas inferidas; una corrección posterior del usuario reemplaza el valor anterior. Las conversaciones recientes y las memorias durables se pueden revisar y borrar por separado desde el sheet. Ninguna memoria escribe ni modifica el ledger, Resumen, proyecciones o Patrimonio.
- CDK provisiona el Gateway de mutaciones, su target Lambda y su Policy Engine con recursos nativos de CloudFormation. El policy engine opera en `ENFORCE`, niega por defecto y sólo permite las siete acciones al rol IAM del Harness. El custom resource `OlbiaAgentCore` reconcilia Harness, Memory, finanzas y Web Search, e incorpora el ARN del Gateway de mutaciones.

## Prompt Management (runtime, sin deploy)

Prompt Management **no** se hornea en el Harness ni se guarda en este repositorio.

1. Única fuente de verdad: Bedrock Prompt Management.
2. Puntero activo: SSM `/personal-finance-v1/agent/runtime-system-prompt-version-arn` → ARN versionado (`…:prompt/ID:N`).
3. El provisioner lee esa versión para crear o reconciliar el Harness.
4. En cada `InvokeHarness`, la Lambda de chat lee el puntero (caché ~30s), hace `GetPrompt`, y pasa prompt, modelo y configuración de inferencia como **override**.

El prompt, el modelo, `temperature` y `maxTokens` nunca tienen contenido, seeds, defaults ni fallbacks hardcodeados en código. CDK administra el recurso nativo `AWS::Bedrock::Prompt`; antes de desplegar, CI lee el DRAFT actual desde Prompt Management y lo pasa como parámetros `NoEcho`, por lo que CloudFormation lo preserva sin guardar contenido en Git. Las versiones inmutables y el puntero activo se administran en runtime. Véase también [`services/api/src/agent/README.md`](../services/api/src/agent/README.md).

### Promote / rollback (sin redeploy)

```bash
# 1) Edita DRAFT en consola Bedrock Prompt Management (o UpdatePrompt)
# 2) Crea versión inmutable
aws bedrock-agent create-prompt-version \
  --prompt-arn arn:aws:bedrock:REGION:ACCOUNT:prompt/PROMPT_ID \
  --description "prod-$(date +%Y%m%d)"

# 3) Apunta producción a esa versión (promote)
aws ssm put-parameter \
  --name /personal-finance-v1/agent/runtime-system-prompt-version-arn \
  --type String \
  --value 'arn:aws:bedrock:REGION:ACCOUNT:prompt/PROMPT_ID:N' \
  --overwrite

# Rollback: vuelve el puntero a :N-1 (o cualquier versión anterior)
```

Los deploys no modifican el prompt ni el puntero SSM.

## Parámetro requerido

Al desplegar, pasa `AgentOwnerSub` = Cognito `sub` del dueño (single-user). Las tools del Gateway no ven el JWT del browser; usan ese owner.

## Tools (primer ship)

| Tool | Rol |
|------|-----|
| `month_snapshot` | Has gastado, Te quedan, proyección, MSI, incertidumbre, sin categoría |
| `plan_month_scenario` | Presupuesto, compromisos con moneda explícita, días/noches y cierres what-if deterministas |
| `spend_by_category` | Totales por categoría (cuota MSI del mes) |
| `spend_by_merchant` | Top comercios (opcional filtro de categoría) |
| `list_movements` | Total sin truncar + detalle acotado por hoy/ayer/semana/7 días/mes/año o rango explícito; conserva semántica de cuota MSI y declara cuando evidencia histórica solo permite precisión mensual |
| `compare_months` | Mes vs anterior / deltas |
| `wealth_snapshot` | Neto / activos / deudas (solo lectura) |
| `investment_history` | Historial DDB de cuenta o posición Bitso/IBKR por día, rango o all-time; distingue cambio de valor de rendimiento cuando cambió la cantidad |
| `WebSearch` | Búsqueda web administrada por AWS; conserva citas y enlaces en la respuesta |
| `preview_tag_edit` | Congela los movimientos `accepted` exactos para un cambio de tags; debe preceder inmediatamente a apply |
| `apply_tag_edit` | Aplica en el mismo turno el snapshot congelado; la instrucción explícita del chat ya es la autorización |
| `undo_tag_edit` | Restaura el estado anterior cuando el usuario lo pide en el chat |
| `preview_category_edit` | Dry run que congela movimientos `accepted` por IDs exactos o por rango con filtro explícito, y devuelve la lista completa `affected`; debe preceder inmediatamente a apply |
| `apply_category_edit` | Aplica en el mismo turno el snapshot congelado; la instrucción explícita del chat ya es la autorización |
| `undo_category_edit` | Restaura la categoría anterior cuando el usuario lo pide en el chat |
| `apply_category_edits` | Aplica atómicamente varios previews category-only sin rondas separadas |

## Categorías

- Catálogo fijo V1 + mapa comercio→categoría en DynamoDB (`CATEGORY_CATALOG`, `CATEGORY_RULES`).
- `categoryId` en el payload del evento; `null`/ausente = Sin categoría.
- Seed: `infrastructure/scripts/propose-category-seed.ts` (aprobar con `--apply`).
- Backfill: `infrastructure/scripts/backfill-event-categories.ts`.

## Auth y chat

- Ledger API: JWT Cognito vía authorizer de API Gateway HTTP API. Chat: authorizer Cognito de API Gateway REST.
- `POST /agent/chat` body: `{ message, month, sessionId? }` → `text/event-stream`; cada evento `data:` usa los shapes `token`, `reasoning_start`, `reasoning_complete`, `tool_start`, `tool_complete`, `tool_failed`, `citation`, `proposal`, `mutation`, `done`, `error`.
- El backend crea o actualiza un índice mínimo owner-scoped en `MetadataTable` (`sessionId`, título derivado de la primera pregunta, primer mes, timestamps y puntero activo). El transcript y el contexto siguen siendo propiedad de AgentCore Memory; DynamoDB no los duplica.
- `GET /agent/threads` lista hasta 20 conversaciones recientes y devuelve `activeThreadId`; también descubre y backfillea sesiones nativas aún vigentes que preceden al índice.
- `GET /agent/threads/{threadId}` reconstruye mensajes visibles con `ListEvents`; `PUT /agent/threads/active` selecciona o limpia el hilo activo y `DELETE /agent/threads/{threadId}` elimina sus eventos crudos y su índice.
- Cerrar el sheet, recargar o cambiar de mes no limpia el hilo. El mes seleccionado se manda como contexto del turno nuevo. La actividad de razonamiento y las duraciones de tools son sólo del stream en vivo y no se recrean como actividad actual al restaurar.
- El cliente (`streamAgentChat`) aplica cada evento en orden y pinta tokens y actividad de tools conforme llegan.
- La UI muestra un indicador compacto de razonamiento y su duración. El proxy nunca envía texto ni firmas privadas del bloque de razonamiento al browser.
- La actividad se inserta dentro de la burbuja del asistente como una nota de trabajo compacta: cada llamada conserva nombre, estado, intento y duración. Al tocar una línea se abre su resumen legible; no se exponen inputs ni payloads crudos.
- Un fallo de tool queda visible como dato no disponible. El agente puede seguir con una respuesta parcial. Cada preview de mutación persiste sólo una operación owner-scoped con TTL. Apply y undo de tags o categorías están aislados en otro Gateway/Lambda y protegidos por Cedar, IAM de mínimo privilegio, revisiones e idempotencia; no existen endpoints públicos `/bulk-edits`.

## Tags, categorías y mutaciones desde chat

- `tags` es una lista normalizada de contexto (`viaje:vegas`, `ciudad:cdmx`) independiente de `categoryId`.
- El mismo movimiento puede tener varios tags; no afectan Resumen, proyecciones, MSI, conciliación ni Patrimonio.
- Una petición explícita del usuario para agregar o quitar tags, o cambiar una categoría, es la autorización del lote. No se solicita una segunda confirmación en la UI.
- `preview_tag_edit` acepta un rango inclusivo. `preview_category_edit` exige `eventId`/`eventIds` exactos —obtenidos con `list_movements`— o un rango inclusivo con `merchantRaw`, `sourceCategoryId` u `onlyUncategorized=true`; rechaza fechas solas. Ambos sólo consideran movimientos `accepted`; rechazados quedan fuera.
- El preview de categorías es un `dryRun` y entrega todos los movimientos `affected`, no una muestra limitada. El agente revisa ese alcance y llama `apply_category_edit` o `apply_category_edits` con los `operationId` correspondientes en el mismo turno.
- El backend congela IDs, valores previos, conteo e importe antes de escribir. Cada evento recibe una revisión con el mismo `operationId`, `source=assistant_chat_tag_edit` o `source=assistant_chat_category_edit` y el dueño configurado como actor.
- La UI recibe un evento SSE `mutation` por cada operación aplicada, refresca el ledger y muestra recibos factuales sin botones de confirmación. Undo se solicita por chat y usa la misma operación congelada.
- Si el evento cambió después del preview, DynamoDB cancela la transacción y exige generar uno nuevo.
- El Gateway directo expone contracts separados para tags y categorías. La tool de categorías sólo acepta `categoryId` y selectores seguros, nunca tags ni reglas de comercio; ninguna edición crea ni actualiza reglas de comercio.
- La Lambda de chat compara el Cognito `sub` con `AgentOwnerSub` antes de invocar el Harness. La Lambda de mutación usa ese mismo owner fijo y nunca acepta un owner del modelo.
- Errores: 1–2 reintentos silenciosos en harness; luego mensaje corto + `requestId`.

## Observabilidad y costo

- Budget Bedrock ~$15/mes con aviso al 80%.
- Sin Bedrock Guardrails en el MVP.

## Fuera de este ship
- IBKR en vivo desde el agente (sigue siendo sync → `wealth_snapshot`).
- Code interpreter.
- Subcategorías.
