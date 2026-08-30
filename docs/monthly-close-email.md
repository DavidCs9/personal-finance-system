# Correo de cierre mensual

Reporte personal de Olbia enviado el día 1 con el mes calendario completo anterior.

## Producto

- Asunto discreto: `Tu cierre de {mes} · lectura de Olbia`; el Neto no aparece en el asunto.
- Capítulo **Tu mes / Dónde se fue**: gasto total, comparación contra el mes anterior, categorías, tags, incertidumbre y puntos de atención.
- Capítulo **Tu patrimonio / Qué cambió**: Neto, activos, deudas, cuentas, vigencia y comparación cuando existe un cierre completo previo.
- Categorías suman el total. Tags se superponen y nunca se suman entre sí.
- No se establece causalidad directa entre gasto mensual y cambios de Patrimonio.
- HTML responsive marfil/carbón y alternativa `text/plain` en el mismo envío SES.

## Semántica financiera

- Gasto usa exactamente **Has gastado**: cuota MSI `spent` del mes, `personalAmountMinor` para Mi parte, rechazados y `pending_foreign` fuera, `needs_review` dentro con importe incierto explícito.
- La comparación de categorías usa el mes previo completo y calcula además promedio por categoría de los tres meses anteriores.
- Patrimonio se resuelve al último día del mes reportado. Cada activo y tarjeta usa su último snapshot en o antes del cierre; Fondo incluye sólo CFDIs con `FechaPago` hasta ese día.
- Los snapshots creados el día 1 quedan fuera del cierre anterior.
- Los cambios de Bitso/IBKR son valor observado en MXN, no rendimiento ajustado por aportaciones, retiros, dividendos o costo base.
- La serie total comparable empieza en `2026-08`; el correo de agosto no inventa una comparación patrimonial con julio.

## IA

La Lambda construye primero un `MonthlyCloseFacts` determinista. Bedrock Converse recibe ese paquete cerrado y devuelve JSON Schema con:

- titular;
- resumen ejecutivo;
- lectura de gasto;
- lectura de patrimonio;
- hasta tres IDs de señales ya calculadas.

La respuesta de IA no admite dígitos, signos de moneda ni porcentajes. Todas las cifras las inserta el renderer desde `MonthlyCloseFacts`. El modelo no usa memoria del chat, tools de mutación ni búsqueda web. `maxTokens` queda acotado explícitamente y el modelo llega por la misma configuración de modelo del prompt activo de Olbia.

La personalización se carga en runtime desde la misma versión inmutable activa que señala `SYSTEM_PROMPT_VERSION_PARAM` para el agente. Actualmente es v10: restaura el perfil personal de v5 y conserva la continuidad de v9. El correo sólo extrae sus secciones privadas de perfil y voz; las reglas de tools del chat se excluyen. El repositorio público no contiene la biografía, prioridades ni filosofía financiera del owner, y el reporte persistido tampoco guarda ese prompt privado.

Si Bedrock falla, un análisis determinista conserva el reporte y SES lo envía de todas formas.

## Ejecución

```text
EventBridge Scheduler · día 1 · 07:10 America/Chihuahua
  → Lambda monthly-close-email
      → eventos + categorías + snapshots as-of
      → MonthlyCloseFacts
      → Bedrock Converse (fallback determinista)
      → HTML + texto
      → SES
      → marca de envío en MetadataTable
```

- Scheduler tiene dos reintentos y DLQ cifrada con retención de 14 días.
- La Lambda registra JSON estructurado, tiene alarma de errores y alarma de mensajes en DLQ.
- Registro owner-scoped: `PK=USER#{owner}`, `SK=MONTHLY_CLOSE#{YYYY-MM}`.
- El registro guarda facts, análisis, versión, HTML/texto preparado, hash, `sesMessageId` y `sentAt` para auditoría/reintento.
- Un reporte `sent` no vuelve a enviarse. Si SES falla, el registro `prepared` conserva exactamente el contenido para el reintento. Como SES `SendEmail` no ofrece una llave idempotente, un fallo excepcional después de aceptar el correo y antes de guardar `sent` puede producir un duplicado; se prefiere ese borde a perder el cierre.

## Infraestructura

- Lambda: `personal-finance-v1-monthly-close-email`.
- Schedule: `personal-finance-v1-monthly-close-email`.
- Destinatario y remitente: parámetros existentes `AlertRecipientEmail` y `SesSenderEmail`.
- Owner: parámetro existente `AgentOwnerSub`.
- Perfil privado: versión activa del prompt nativo `OlbiaFinanceSystem`, resuelta por SSM y leída con `bedrock:GetPrompt`; la baseline actual es v10.
- CTA: `WEB_APP_URL` existente.
- Despliegue únicamente por PR y el job `deploy-production` después de integrar a `main`.
