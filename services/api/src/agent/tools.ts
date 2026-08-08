import {
  compareMonths,
  listMovementsForAgent,
  monthSnapshot,
  proposeRecategorize,
  spendByCategory,
  spendByMerchant,
  wealthSnapshotForAgent,
} from './aggregates.js';

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

export const runAgentTool = async (
  owner: string,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> => {
  switch (name) {
    case 'month_snapshot':
      return monthSnapshot(owner, String(input.month));
    case 'spend_by_category':
      return spendByCategory(String(input.month));
    case 'spend_by_merchant':
      return spendByMerchant(String(input.month), {
        categoryId: typeof input.categoryId === 'string' ? input.categoryId : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      });
    case 'list_movements':
      return listMovementsForAgent(String(input.month), {
        categoryId: typeof input.categoryId === 'string' ? input.categoryId : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      });
    case 'compare_months':
      return compareMonths(
        String(input.month),
        typeof input.against === 'string' ? input.against : undefined,
      );
    case 'wealth_snapshot':
      return wealthSnapshotForAgent(owner);
    case 'propose_recategorize':
      return proposeRecategorize({
        eventId: String(input.eventId),
        categoryId: String(input.categoryId),
        merchantRaw: typeof input.merchantRaw === 'string' ? input.merchantRaw : undefined,
      });
    default:
      throw new Error(`Tool desconocida: ${name}`);
  }
};

export const citationsFromToolResult = (
  toolName: string,
  result: unknown,
): readonly { readonly kind: string; readonly id?: string; readonly label: string }[] => {
  if (!result || typeof result !== 'object') return [];
  const data = result as Record<string, unknown>;
  if (toolName === 'list_movements' && Array.isArray(data.movements)) {
    return (data.movements as { id: string; merchantRaw: string }[]).slice(0, 8).map((row) => ({
      kind: 'movement',
      id: row.id,
      label: row.merchantRaw,
    }));
  }
  if (toolName === 'month_snapshot') {
    return [{ kind: 'summary', label: `Resumen ${String(data.month ?? '')}`.trim() }];
  }
  if (toolName === 'wealth_snapshot') {
    return [{ kind: 'wealth', label: 'Patrimonio' }];
  }
  if (toolName === 'spend_by_category' && Array.isArray(data.buckets)) {
    return (data.buckets as { label: string }[]).slice(0, 6).map((bucket) => ({
      kind: 'category',
      label: bucket.label,
    }));
  }
  return [];
};
