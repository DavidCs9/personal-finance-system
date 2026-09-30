import { DEFAULT_SPEND_CATEGORIES, monthKeyInZone } from '@finance/domain';

export type SourceKey = { PK: string; SK: string };
export type SourceItem = SourceKey & Record<string, unknown>;
export type SqlRow = { table: TableName; values: Record<string, unknown> };

// No foreign keys yet: a DynamoDB transaction's items arrive independently.
// Source envelopes are retained in checkpoints; payloads retain optional fields.
export const TABLE_COLUMNS = {
  movements: { id: 'text', institution: 'text', event_type: 'text', status: 'text', amount_minor: 'bigint', currency: 'text', personal_amount_minor: 'bigint', merchant_raw: 'text', category_id: 'text', spend_month: 'text', occurred_at: 'timestamptz', received_at: 'timestamptz', payload: 'jsonb' },
  movement_observations: { id: 'text', movement_id: 'text', capture_source: 'text', payload: 'jsonb' },
  movement_revisions: { id: 'text', movement_id: 'text', created_at: 'timestamptz', payload: 'jsonb' },
  categories: { id: 'text', name: 'text', sort_order: 'integer', payload: 'jsonb' },
  merchant_category_rules: { id: 'text', merchant_key: 'text', category_id: 'text', payload: 'jsonb' },
  cards: { id: 'text', owner: 'text', name: 'text', cut_off_day: 'integer', payment_due_day: 'integer', payload: 'jsonb' },
  movement_tags: { movement_id: 'text', tag: 'text', payload: 'jsonb' },
  msi_plans: { movement_id: 'text', months: 'integer', principal_minor: 'bigint', cuota_minor: 'bigint', status: 'text', needs_schedule_completion: 'boolean', payload: 'jsonb' },
  msi_installments: { movement_id: 'text', installment_index: 'integer', month: 'text', amount_minor: 'bigint', status: 'text', occurred_on: 'date', payload: 'jsonb' },
} as const;
export type TableName = keyof typeof TABLE_COLUMNS;
export const TABLE_NAMES = Object.keys(TABLE_COLUMNS) as TableName[];
export const PROJECTION_VERSION = 1;

export const entityForKey = (key: SourceKey): TableName | undefined => {
  if (key.PK.startsWith('EVENT#')) {
    if (key.SK === 'EVENT') return 'movements';
    if (key.SK.startsWith('OBSERVATION#')) return 'movement_observations';
    if (key.SK.startsWith('REVISION#')) return 'movement_revisions';
  }
  if (key.PK === 'CATEGORY_CATALOG' && key.SK.startsWith('CAT#')) return 'categories';
  if (key.PK === 'CATEGORY_RULES' && key.SK.startsWith('RULE#')) return 'merchant_category_rules';
  if (key.PK.startsWith('USER#') && key.SK.startsWith('CARD#')) return 'cards';
  return undefined;
};

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid projection object');
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== 'string' || !value) throw new Error('Invalid projection string');
  return value;
};
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Invalid projection integer');
  return value;
};
const optional = (value: unknown): unknown => value ?? null;

export const projectRows = (key: SourceKey, item?: SourceItem): SqlRow[] => {
  const table = entityForKey(key);
  if (!table) return [];
  const defaultCategory = table === 'categories'
    ? DEFAULT_SPEND_CATEGORIES.find((category) => key.SK === `CAT#${category.id}`) : undefined;
  if (!item && !defaultCategory) return [];
  const p = table === 'categories' || table === 'merchant_category_rules'
    ? object(item ?? defaultCategory) : object(item?.payload);
  const id = string(p.id);
  const row = (target: TableName, rowId: string, values: Record<string, unknown>): SqlRow => ({
    table: target, values: { source_pk: key.PK, source_sk: key.SK, row_id: rowId, ...values },
  });
  if (table === 'movements') {
    if (key.PK !== `EVENT#${id}`) throw new Error('Movement ID does not match source key');
    const amount = object(p.amount);
    const rows = [row(table, id, {
      id, institution: string(p.institution), event_type: string(p.eventType), status: string(p.status),
      amount_minor: integer(amount.amountMinor), currency: string(amount.currency),
      personal_amount_minor: p.personalAmountMinor == null ? null : integer(p.personalAmountMinor),
      merchant_raw: string(p.merchantRaw), category_id: optional(p.categoryId),
      spend_month: monthKeyInZone(new Date(string(p.occurredAt ?? p.receivedAt))),
      occurred_at: optional(p.occurredAt), received_at: string(p.receivedAt), payload: p,
    })];
    if (p.tags !== undefined && !Array.isArray(p.tags)) throw new Error('Invalid tags');
    for (const tag of new Set((p.tags ?? []) as unknown[])) {
      const name = string(tag);
      rows.push(row('movement_tags', name, { movement_id: id, tag: name, payload: { tag: name } }));
    }
    if (p.msi != null) {
      const plan = object(p.msi);
      rows.push(row('msi_plans', id, {
        movement_id: id, months: integer(plan.months), principal_minor: integer(plan.principalMinor),
        cuota_minor: integer(plan.cuotaMinor), status: string(plan.status),
        needs_schedule_completion: optional(plan.needsScheduleCompletion), payload: plan,
      }));
      if (!Array.isArray(plan.installments)) throw new Error('Invalid installments');
      const indices = new Set<number>();
      for (const value of plan.installments) {
        const installment = object(value);
        const index = integer(installment.index);
        if (indices.has(index)) throw new Error('Duplicate installment index');
        indices.add(index);
        rows.push(row('msi_installments', String(index), {
          movement_id: id, installment_index: index, month: string(installment.month),
          amount_minor: integer(installment.amountMinor), status: string(installment.status),
          occurred_on: optional(installment.occurredOn), payload: installment,
        }));
      }
    }
    // Bound delete+insert work well below DSQL's 3,000-row / 10-MiB transaction limits.
    if (rows.length > 900 || Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024) {
      throw new Error('Projection exceeds transaction budget');
    }
    return rows;
  }
  if (table === 'movement_observations') return [row(table, id, {
    id, movement_id: key.PK.slice('EVENT#'.length), capture_source: optional(p.captureSource), payload: p,
  })];
  if (table === 'movement_revisions') return [row(table, id, {
    id, movement_id: key.PK.slice('EVENT#'.length), created_at: string(p.createdAt), payload: p,
  })];
  if (table === 'categories') return [row(table, id, {
    id, name: string(p.name), sort_order: integer(p.sortOrder),
    payload: { id, name: p.name, sortOrder: p.sortOrder },
  })];
  if (table === 'merchant_category_rules') return [row(table, id, {
    id, merchant_key: string(p.merchantKey), category_id: optional(p.categoryId), payload: p,
  })];
  return [row('cards', id, {
    id, owner: string(item?.owner), name: string(p.name), cut_off_day: integer(p.cutOffDay),
    payment_due_day: integer(p.paymentDueDay), payload: p,
  })];
};

export const tablesForKey = (key: SourceKey): TableName[] => {
  const table = entityForKey(key);
  return table === 'movements' ? ['movements', 'movement_tags', 'msi_plans', 'msi_installments']
    : table ? [table] : [];
};

export const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, current) => {
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  }
  return current;
});
