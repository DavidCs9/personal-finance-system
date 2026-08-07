# Asistente Olbia (AgentCore)

Documento técnico del asistente de consultas financieras. Decisiones de producto viven en [`ui-design-brief.md`](ui-design-brief.md) y [`apps/web/AGENTS.md`](../apps/web/AGENTS.md).

## Norte

Un solo asistente: consultas ahora; asesor de decisión (“¿qué tan responsable…?”) después, como el mismo Harness con más tools.

## Arquitectura

```
SPA (JWT Cognito)
  → API Gateway HTTP API
    → Lambda agent-proxy (SSE)
      → AgentCore Harness (InvokeHarness, SigV4)
        → AgentCore Gateway (MCP)
          → Lambda agent-tools
            → funciones de agregación (@finance/api agent/aggregates)
              → DynamoDB + computeMonthSummary
```

- El browser **nunca** habla con AgentCore.
- Las tools no inventan montos: solo devuelven JSON de agregación.
- Code interpreter: **apagado** en el primer ship.
- Memoria de producto: solo mientras el sheet está abierto (`runtimeSessionId`); al cerrar o cambiar el mes del selector se limpia el hilo.
- Fallback de desarrollo/producción inicial: si `HARNESS_ARN` está vacío, el proxy usa **Bedrock ConverseStream** con el mismo dispatch de tools en-proceso. Tras crear el Harness + Gateway, setea `HARNESS_ARN` en la Lambda `agent-proxy`.

### Provisionar Harness (post-deploy)

```bash
# Usa el ARN de salida AgentCoreHarnessExecutionRoleArn
aws bedrock-agentcore-control create-harness \
  --region us-east-2 \
  --harness-name OlbiaFinance \
  --execution-role-arn "<HarnessExecutionRoleArn>" \
  --model '{"bedrockModelConfig":{"modelId":"anthropic.claude-sonnet-4-6","maxTokens":2048,"temperature":0.2,"apiFormat":"converse_stream"}}' \
  --system-prompt '[{"text":"...voz Olbia..."}]' \
  --memory '{"disabled":{}}' \
  --max-iterations 25 \
  --max-tokens 4096 \
  --timeout-seconds 300
```

Luego Gateway con target Lambda de tools (mismo schema que `TOOL_DEFINITIONS`) y adjunta `agentcore_gateway` al Harness. Actualiza `HARNESS_ARN` en `personal-finance-v1-agent-proxy`.

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
- Ingestión futura: reglas primero; residuales con modelo; corrección en Movimientos.

## Auth y streaming

- Rutas del agente detrás del mismo JWT Cognito.
- Respuesta: `text/event-stream` (SSE) desde `agent-proxy`.
- Errores: 1–2 reintentos silenciosos; luego mensaje corto + `requestId` copiable.

## Observabilidad y costo

- Model invocation logging de Bedrock con prompt/output (cuenta single-user; retención larga a conciencia).
- Alarma de costo / uso con umbral bajo al inicio.
- Sin Bedrock Guardrails en el MVP.

## Fuera de este ship

- Asesor de responsabilidad / what-if.
- IBKR en vivo desde el agente (sigue siendo sync → `wealth_snapshot`).
- Code interpreter.
- Historial de chat durable en UI.
- Subcategorías.
