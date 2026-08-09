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
- Las tools viven detrás de **Gateway**: un target Lambda para finanzas y el [conector administrado Web Search Tool](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connector-web-search-tool.html) para información pública con citas.
- Harness, Memory y Gateway corren en `us-east-1`, requerido por Web Search Tool. La Lambda financiera y DynamoDB permanecen en `us-east-2` y se invocan cross-region.
- Code interpreter: **apagado**.
- Memoria de conversación: AgentCore Memory conserva automáticamente y de forma amplia contexto útil entre sesiones (planes, metas, preferencias, restricciones y decisiones), aislado por Cognito `sub`. Se prefiere retener de más para que el usuario no tenga que repetir contexto; las memorias durables se pueden revisar y borrar desde el sheet. El hilo visible sigue limpiándose al cerrar o cambiar el mes. Nunca escribe ni modifica el ledger, Resumen, proyecciones o Patrimonio.
- CDK provisiona Gateway + Target + Harness vía custom resource (`OlbiaAgentCore`) y inyecta `HARNESS_ARN` en las Lambdas de chat.

## Prompt Management (runtime, sin deploy)

Prompt Management **no** se hornea en el Harness ni se guarda en este repositorio.

1. Única fuente de verdad: Bedrock Prompt Management.
2. Puntero activo: SSM `/personal-finance-v1/agent/runtime-system-prompt-version-arn` → ARN versionado (`…:prompt/ID:N`).
3. El provisioner lee esa versión para crear o reconciliar el Harness.
4. En cada `InvokeHarness`, la Lambda de chat lee el puntero (caché ~30s), hace `GetPrompt`, y pasa prompt, modelo y configuración de inferencia como **override**.

El prompt, el modelo, `temperature` y `maxTokens` nunca tienen contenido, seeds, defaults ni fallbacks hardcodeados en código. CDK no crea, actualiza ni elimina el recurso de Prompt Management ni el parámetro SSM; ambos son prerrequisitos operativos externos al stack. Véase también [`services/api/src/agent/README.md`](../services/api/src/agent/README.md).

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
| `spend_by_category` | Totales por categoría (cuota MSI del mes) |
| `spend_by_merchant` | Top comercios (opcional filtro de categoría) |
| `list_movements` | Detalle acotado (N filas) |
| `compare_months` | Mes vs anterior / deltas |
| `wealth_snapshot` | Neto / activos / deudas (solo lectura) |
| `investment_history` | Historial DDB de cuenta o posición Bitso/IBKR por día, rango o all-time; distingue cambio de valor de rendimiento cuando cambió la cantidad |
| `WebSearch` | Búsqueda web administrada por AWS; conserva citas y enlaces en la respuesta |
| `propose_recategorize` | Propone cambio; la UI confirma (`set_category` + regla) |

## Categorías

- Catálogo fijo V1 + mapa comercio→categoría en DynamoDB (`CATEGORY_CATALOG`, `CATEGORY_RULES`).
- `categoryId` en el payload del evento; `null`/ausente = Sin categoría.
- Seed: `infrastructure/scripts/propose-category-seed.ts` (aprobar con `--apply`).
- Backfill: `infrastructure/scripts/backfill-event-categories.ts`.

## Auth y chat

- Ledger API: JWT Cognito vía authorizer de API Gateway HTTP API. Chat: authorizer Cognito de API Gateway REST.
- `POST /agent/chat` body: `{ message, month, sessionId? }` → `text/event-stream`; cada evento `data:` usa los shapes `token`, `tool_start`, `tool_complete`, `tool_failed`, `citation`, `proposal`, `done`, `error`.
- El cliente (`streamAgentChat`) aplica cada evento en orden y pinta tokens y actividad de tools conforme llegan.
- La actividad se inserta dentro de la burbuja del asistente como una nota de trabajo compacta: cada llamada conserva nombre, estado, intento y duración. Al tocar una línea se abre su resumen legible; no se exponen inputs ni payloads crudos.
- Un fallo de tool queda visible como dato no disponible. El agente puede seguir con una respuesta parcial; las mutaciones siguen limitadas a confirmar `propose_recategorize`.
- Errores: 1–2 reintentos silenciosos en harness; luego mensaje corto + `requestId`.

## Observabilidad y costo

- Budget Bedrock ~$15/mes con aviso al 80%.
- Sin Bedrock Guardrails en el MVP.

## Fuera de este ship

- Asesor de responsabilidad / what-if.
- IBKR en vivo desde el agente (sigue siendo sync → `wealth_snapshot`).
- Code interpreter.
- Historial de chat durable en UI.
- Subcategorías.
