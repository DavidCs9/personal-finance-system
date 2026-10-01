import { DEFAULT_SPEND_CATEGORIES, monthKeyInZone, isWealthAccountId, FONDO_AHORRO_ACCOUNT_ID } from '@finance/domain';

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
  cards: { id: 'text', owner: 'text', name: 'text', cut_off_day: 'integer', payment_due_day: 'integer', payload: 'jsonb', source_item: 'jsonb' },
  movement_tags: { movement_id: 'text', tag: 'text', payload: 'jsonb' },
  msi_plans: { movement_id: 'text', months: 'integer', principal_minor: 'bigint', cuota_minor: 'bigint', status: 'text', needs_schedule_completion: 'boolean', payload: 'jsonb' },
  msi_installments: { movement_id: 'text', installment_index: 'integer', month: 'text', amount_minor: 'bigint', status: 'text', occurred_on: 'date', payload: 'jsonb' },
  monthly_plans: { owner: 'text', month: 'text', payload: 'jsonb', source_item: 'jsonb' },
  payroll: { owner: 'text', month: 'text', uuid: 'text', fecha_pago: 'date', total_minor: 'bigint', currency: 'text', ingested_at: 'timestamptz', source: 'jsonb', payload: 'jsonb', source_item: 'jsonb' },
  wealth_snapshots: { account_id: 'text', owner: 'text', day: 'date', captured_at: 'timestamptz', source: 'text', currency: 'text', total_mxn_minor: 'bigint', evidence: 'jsonb', payload: 'jsonb', source_item: 'jsonb', holdings: 'jsonb', fx_rate: 'double precision', fx_source: 'text' },
  wealth_versions: { account_id: 'text', owner: 'text', day: 'date', captured_at: 'timestamptz', source: 'text', currency: 'text', total_mxn_minor: 'bigint', evidence: 'jsonb', payload: 'jsonb', source_item: 'jsonb', holdings: 'jsonb', fx_rate: 'double precision', fx_source: 'text', version_id: 'text', superseded_at: 'timestamptz' },
  liability_snapshots: { card_id: 'text', owner: 'text', day: 'date', captured_at: 'timestamptz', source: 'text', currency: 'text', total_mxn_minor: 'bigint', evidence: 'jsonb', payload: 'jsonb', source_item: 'jsonb' },
  liability_versions: { card_id: 'text', owner: 'text', day: 'date', captured_at: 'timestamptz', source: 'text', currency: 'text', total_mxn_minor: 'bigint', evidence: 'jsonb', payload: 'jsonb', source_item: 'jsonb', version_id: 'text', superseded_at: 'timestamptz' },
} as const;
export type TableName = keyof typeof TABLE_COLUMNS;
export const TABLE_NAMES = Object.keys(TABLE_COLUMNS) as TableName[];
export const PROJECTION_VERSION = 3;

export const entityForKey = (key: SourceKey): TableName | undefined => {
  if (key.PK.startsWith('EVENT#')) {
    if (key.SK === 'EVENT') return 'movements';
    if (key.SK.startsWith('OBSERVATION#')) return 'movement_observations';
    if (key.SK.startsWith('REVISION#')) return 'movement_revisions';
  }
  if (key.PK === 'CATEGORY_CATALOG' && key.SK.startsWith('CAT#')) return 'categories';
  if (key.PK === 'CATEGORY_RULES' && key.SK.startsWith('RULE#')) return 'merchant_category_rules';
  if (key.PK.startsWith('USER#') && key.SK.startsWith('CARD#')) return 'cards';
  if (key.PK.startsWith('USER#') && /^MONTH#\d{4}-\d{2}$/.test(key.SK)) return 'monthly_plans';
  if (key.PK.startsWith('USER#') && /^PAYROLL#\d{4}-\d{2}#.+$/.test(key.SK)) return 'payroll';
  if (key.PK.startsWith('USER#')) {
    if (/^WEALTH_SNAP#[^#]+#\d{4}-\d{2}-\d{2}$/.test(key.SK)) return 'wealth_snapshots';
    if (/^WEALTH_VER#[^#]+#\d{4}-\d{2}-\d{2}#.+$/.test(key.SK)) return 'wealth_versions';
    if (/^LIAB_SNAP#[^#]+#\d{4}-\d{2}-\d{2}$/.test(key.SK)) return 'liability_snapshots';
    if (/^LIAB_VER#[^#]+#\d{4}-\d{2}-\d{2}#.+$/.test(key.SK)) return 'liability_versions';
  }
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
    ? object(item ?? defaultCategory) : object(table.startsWith('wealth_') || table.startsWith('liability_') ? item : item?.payload);
  const row = (target: TableName, rowId: string, values: Record<string, unknown>): SqlRow => ({
    table: target, values: { source_pk: key.PK, source_sk: key.SK, row_id: rowId, ...values },
  });
  if (table.startsWith('wealth_') || table.startsWith('liability_')) {
    const wealth = table.startsWith('wealth_');
    const version = table.endsWith('_versions');
    const owner = string(p.owner), id = string(wealth ? p.accountId : p.cardId);
    const day = string(p.day), capturedAt = string(p.capturedAt);
    const prefix = wealth ? (version ? 'WEALTH_VER' : 'WEALTH_SNAP') : (version ? 'LIAB_VER' : 'LIAB_SNAP');
    if (key.PK !== `USER#${owner}` || key.SK !== `${prefix}#${id}#${day}${version ? `#${capturedAt}` : ''}`) throw new Error('Snapshot identity does not match source key');
    if (wealth && (!isWealthAccountId(id) || id === FONDO_AHORRO_ACCOUNT_ID)) throw new Error('Invalid persisted wealth account');
    if (!wealth && !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid liability card');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(capturedAt))) throw new Error('Invalid snapshot date');
    const total = integer(p.totalMxnMinor);
    if ((!wealth && total < 0) || p.currency !== 'MXN' || !(wealth ? ['manual', 'api', 'flex'] : ['manual']).includes(string(p.source))) throw new Error('Invalid snapshot balance/source');
    if (wealth) {
      if (!Array.isArray(p.holdings)) throw new Error('Invalid embedded holdings');
      for (const holding of p.holdings) {
        const h = object(holding); string(h.id); string(h.currency); integer(h.valueMxnMinor);
      }
      if (p.fxRate != null && (typeof p.fxRate !== 'number' || !Number.isFinite(p.fxRate))) throw new Error('Invalid FX rate');
    }
    const values = { owner, [wealth ? 'account_id' : 'card_id']: id, day, captured_at: capturedAt,
      source: p.source, currency: p.currency, total_mxn_minor: total, evidence: optional(p.evidence), payload: p, source_item: item,
      ...(wealth ? { holdings: p.holdings, fx_rate: optional(p.fxRate), fx_source: optional(p.fxSource) } : {}),
      ...(version ? { version_id: string(p.versionId), superseded_at: string(p.supersededAt) } : {}) };
    const rows = [row(table, version ? string(p.versionId) : key.SK, values)];
    if (Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024) throw new Error('Projection exceeds transaction budget');
    return rows;
  }
  if (table === 'monthly_plans' || table === 'payroll') {
    const owner = string(item?.owner);
    const month = string(item?.month);
    if (key.PK !== `USER#${owner}`) throw new Error('Planning owner does not match source key');
    if (Buffer.byteLength(JSON.stringify(item)) > 4 * 1024 * 1024) throw new Error('Projection exceeds transaction budget');
    if (table === 'monthly_plans') {
      if (key.SK !== `MONTH#${month}`) throw new Error('Plan month does not match source key');
      if (!Array.isArray(p.upcomingPayments)) throw new Error('Invalid planned payments');
      for (const value of p.upcomingPayments) integer(object(value).amountMinor);
      return [row(table, month, { owner, month, payload: p, source_item: item })];
    }
    const uuid = string(p.uuid);
    if (key.SK !== `PAYROLL#${month}#${uuid}` || p.month !== month || item?.uuid !== uuid) throw new Error('Payroll identity does not match source key');
    for (const field of ['totalPercepcionesMinor', 'totalDeduccionesMinor', 'totalOtrosPagosMinor']) integer(p[field]);
    if (!Array.isArray(p.lines)) throw new Error('Invalid payroll lines');
    for (const line of p.lines) integer(object(line).amountMinor);
    return [row(table, uuid, { owner, month, uuid, fecha_pago: string(p.fechaPago), total_minor: integer(p.totalMinor),
      currency: 'MXN', ingested_at: optional(item?.ingestedAt), source: optional(item?.source), payload: p, source_item: item })];
  }
  const id = string(p.id);
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
    payment_due_day: integer(p.paymentDueDay), payload: p, source_item: item,
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
