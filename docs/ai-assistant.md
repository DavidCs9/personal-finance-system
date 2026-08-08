# Asistente Olbia (AgentCore Harness)

Documento técnico del asistente de consultas financieras. Decisiones de producto viven en [`ui-design-brief.md`](ui-design-brief.md) y [`apps/web/AGENTS.md`](../apps/web/AGENTS.md).

## Norte

Un solo asistente: consultas ahora; asesor de decisión (“¿qué tan responsable…?”) después, como el mismo Harness con más tools.

## Arquitectura

```
SPA (JWT Cognito)
  → API Gateway HTTP API  POST /agent/chat  ← chat producto (JSON buffered)
    → Lambda agent-chat (collectAgentChat)
      → SSM pointer → Bedrock Prompt Management (versión pineada)
      → AgentCore Harness (InvokeHarness + systemPrompt/model override)
        → AgentCore Gateway (MCP, AWS_IAM)
          → Lambda agent-tools (AGENT_OWNER)
            → agregaciones (@finance/api agent/aggregates)
              → DynamoDB + computeMonthSummary

SPA (JWT Cognito)
  → API Gateway HTTP API  ← resto del ledger
    → Lambda api / tools auxiliares
```

- El browser **nunca** habla con AgentCore.
- El chat de producto usa **JSON buffered** por API Gateway (`POST /agent/chat`), el mismo CORS/JWT que el resto de la app. Esto evita fallos de Safari/iOS con SSE cross-origin a Function URL.
- Function URL `RESPONSE_STREAM` + `agent-proxy` quedan **deprecated** (rollback only); el SPA ya no publica ni usa `agentChatUrl`.
- El loop del agente lo corre **Harness** (no un Converse manual en la Lambda).
- Las tools viven detrás de **Gateway** (Lambda target).
- Code interpreter: **apagado**.
- Memoria de producto: solo mientras el sheet está abierto (`runtimeSessionId`); al cerrar o cambiar el mes se limpia el hilo. Harness memory = `disabled`.
- CDK provisiona Gateway + Target + Harness vía custom resource (`OlbiaAgentCore`) y inyecta `HARNESS_ARN` en las Lambdas de chat.

## Prompt Management (runtime, sin deploy)

Prompt Management **no** se hornea en el Harness al desplegar. Eso lo volvería obsoleto.

1. Source of truth editable: Bedrock Prompt Management (`OlbiaFinanceSystem`).
2. Repo seed (solo bootstrap / sync de DRAFT): `services/api/src/agent/prompts/olbia-system.ts` → `AWS::Bedrock::Prompt` + versión `bootstrap`.
3. Puntero activo (mutable sin CDK): SSM `/personal-finance-v1/agent/system-prompt-version-arn` → ARN versionado (`…:prompt/ID:N`).
4. En cada `InvokeHarness`, el chat Lambda lee el puntero (caché ~30s), hace `GetPrompt`, y pasa `systemPrompt` + `model` como **override** de invocación.

### Promote / rollback (sin redeploy)

```bash
# 1) Edita DRAFT en consola Bedrock Prompt Management (o UpdatePrompt)
# 2) Crea versión inmutable
aws bedrock-agent create-prompt-version \
  --prompt-arn arn:aws:bedrock:REGION:ACCOUNT:prompt/PROMPT_ID \
  --description "prod-$(date +%Y%m%d)"

# 3) Apunta producción a esa versión (promote)
aws ssm put-parameter \
  --name /personal-finance-v1/agent/system-prompt-version-arn \
  --type String \
  --value 'arn:aws:bedrock:REGION:ACCOUNT:prompt/PROMPT_ID:N' \
  --overwrite

# Rollback: vuelve el puntero a :N-1 (o cualquier versión anterior)
```

El seed de SSM solo corre en **Create** del custom resource; los redeploys **no** pisan un promote/rollback manual.

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
| `propose_recategorize` | Propone cambio; la UI confirma (`set_category` + regla) |

## Categorías

- Catálogo fijo V1 + mapa comercio→categoría en DynamoDB (`CATEGORY_CATALOG`, `CATEGORY_RULES`).
- `categoryId` en el payload del evento; `null`/ausente = Sin categoría.
- Seed: `infrastructure/scripts/propose-category-seed.ts` (aprobar con `--apply`).
- Backfill: `infrastructure/scripts/backfill-event-categories.ts`.

## Auth y chat

- Ledger API + chat: JWT Cognito vía authorizer de API Gateway HTTP API.
- `POST /agent/chat` body: `{ message, month, sessionId? }` → `{ requestId, sessionId, events: [...] }` (mismos shapes que antes: `token`, `citation`, `proposal`, `done`, `error`).
- El cliente (`postAgentChat`) aplica los `events` en orden; la UI pinta la respuesta completa al llegar (sin stream token-a-token).
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
- Reintroducir SSE (solo si hay path same-origin estable en iOS).
