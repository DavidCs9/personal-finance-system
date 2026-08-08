export const TOOL_DEFINITIONS = [
  {
    name: 'month_snapshot',
    description:
      'Resumen del mes: Has gastado, Te quedan, proyección, MSI, incertidumbre y monto sin categoría. Usa la misma matemática que Resumen.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'Mes YYYY-MM' },
      },
      required: ['month'],
    },
  },
  {
    name: 'spend_by_category',
    description:
      'Gasto del mes por categoría (cuota MSI del mes, no el ticket completo). Incluye Sin categoría.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string' },
      },
      required: ['month'],
    },
  },
  {
    name: 'spend_by_merchant',
    description: 'Top comercios del mes; opcionalmente filtrado por categoryId.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string' },
        categoryId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['month'],
    },
  },
  {
    name: 'list_movements',
    description: 'Lista acotada de movimientos que respaldan un total (máx 50).',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string' },
        categoryId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['month'],
    },
  },
  {
    name: 'compare_months',
    description: 'Compara gasto total y por categoría entre dos meses (default: mes vs anterior).',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string' },
        against: { type: 'string' },
      },
      required: ['month'],
    },
  },
  {
    name: 'wealth_snapshot',
    description: 'Patrimonio neto, activos y deudas de tarjeta (solo lectura).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'propose_recategorize',
    description:
      'Propone recategorizar un movimiento. No aplica el cambio; la UI debe confirmar.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        categoryId: { type: 'string' },
        merchantRaw: { type: 'string' },
      },
      required: ['eventId', 'categoryId'],
    },
  },
] as const;

export type AgentToolName = (typeof TOOL_DEFINITIONS)[number]['name'];
