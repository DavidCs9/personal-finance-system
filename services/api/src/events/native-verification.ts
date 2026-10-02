import type { ReadSqlClient } from './sql-reads.js';
import type { JsonObject } from '../http/response.js';
import { samePublicResult } from './read-selection.js';
import { spendMonthOf, type EventFeed } from './month-feed.js';
import type { MonthSummary } from '@finance/domain';

const iso = (value: unknown): string | undefined => value == null ? undefined : new Date(value as string | Date).toISOString();
const number = (value: unknown): number | undefined => value == null ? undefined : Number(value);
const account = (row: JsonObject): JsonObject | undefined => row.account_present ? {
  accountId: row.account_id ?? undefined, displayName: row.account_name ?? undefined,
  institution: row.account_institution ?? undefined, lastFour: row.account_last_four ?? undefined,
} : undefined;
const source = (row: JsonObject): JsonObject => ({ ...row.source_metadata as JsonObject,
  ...(row.source_kind == null ? {} : { kind: row.source_kind }),
  ...(row.evidence_bucket == null ? {} : { bucket: row.evidence_bucket, key: row.evidence_key,
    sha256: row.evidence_sha256, contentType: row.evidence_content_type }),
});
const pick = (row: JsonObject, fields: readonly string[]): JsonObject => Object.fromEntries(fields.map(field => [field, row[field]]));

const requiredRelations = [
  'ledger_movements_primary_observation_fk', 'ledger_movements_category_id_fkey',
  'ledger_observations_movement_id_fkey', 'ledger_observations_position_key',
  'ledger_revisions_movement_id_fkey', 'ledger_revisions_operation_id_fkey',
  'ledger_bulk_members_operation_id_fkey', 'ledger_bulk_members_movement_id_fkey',
  'installment_plans_movement_id_fkey', 'installment_entries_movement_id_fkey',
  'installment_entries_month_key', 'installment_entries_evidence_fk', 'source_claims_observation_fk',
] as const;

/** Raw typed facts are a separate oracle from the product decoder. Frozen documents are recovery only. */
export const verifyNativeLedgerState = async (client: ReadSqlClient, movements: readonly JsonObject[],
  readDetail: (id: string) => Promise<JsonObject | undefined>) => {
  const [parents, observations, revisions, tags, warnings, observationWarnings, plans, entries, constraints] = await Promise.all([
    client.query('SELECT * FROM olbia.ledger_movements ORDER BY id'),
    client.query('SELECT * FROM olbia.ledger_observations ORDER BY movement_id,position'),
    client.query('SELECT * FROM olbia.ledger_revisions ORDER BY movement_id,created_at DESC,id DESC'),
    client.query('SELECT * FROM olbia.ledger_tags ORDER BY movement_id,position'),
    client.query('SELECT * FROM olbia.ledger_movement_warnings ORDER BY movement_id,position'),
    client.query('SELECT * FROM olbia.ledger_observation_warnings ORDER BY observation_id,position'),
    client.query('SELECT * FROM olbia.installment_plans ORDER BY movement_id'),
    client.query('SELECT * FROM olbia.installment_entries ORDER BY movement_id,installment_index'),
    client.query(`SELECT conname,convalidated FROM pg_constraint WHERE connamespace='olbia'::regnamespace
      AND conname=ANY($1::text[]) ORDER BY conname`, [[...requiredRelations]]),
  ]);
  let mismatches = 0;
  const check = (a: unknown, b: unknown) => { mismatches += Number(!samePublicResult(a, b)); };
  check([...requiredRelations].sort().map(conname => ({ conname, convalidated: true })), constraints.rows);
  check(parents.rows.map(row => row.id), movements.map(row => row.id).sort());
  const children = (rows: JsonObject[], field: string, id: unknown) => rows.filter(row => row[field] === id);
  const contiguous = (rows: JsonObject[]) => rows.every((row, position) => Number(row.position) === position);
  const observationFacts = (row: JsonObject): JsonObject => ({ id: row.id, eventId: row.movement_id,
    captureSource: row.capture_source, observedAt: iso(row.observed_at), reconciliationAt: iso(row.reconciliation_at),
    institution: row.institution, eventType: row.event_type, amount: { amountMinor: number(row.amount_minor), currency: row.currency },
    merchantRaw: row.merchant_raw, occurredAt: iso(row.occurred_at), account: account(row), source: source(row),
    parserVersion: row.parser_version, parseWarnings: children(observationWarnings.rows, 'observation_id', row.id).map(w => w.message),
    bankTransactionId: row.bank_transaction_id ?? undefined, rowNumber: number(row.csv_row_number), note: row.note ?? undefined,
  });
  let details = 0;
  for (const parent of parents.rows) {
    const captures = children(observations.rows, 'movement_id', parent.id);
    const primary = captures.find(row => row.id === parent.primary_observation_id);
    const movementTags = children(tags.rows, 'movement_id', parent.id);
    const movementWarnings = children(warnings.rows, 'movement_id', parent.id);
    check(true, Boolean(primary) && contiguous(captures) && contiguous(movementTags) && contiguous(movementWarnings));
    for (const capture of captures) check(true, contiguous(children(observationWarnings.rows, 'observation_id', capture.id)));
    if (!primary) continue;
    const plan = plans.rows.find(row => row.movement_id === parent.id);
    const expectedPlan = plan ? { months: plan.months, principalMinor: number(plan.principal_minor), cuotaMinor: number(plan.cuota_minor),
      origin: plan.origin, status: plan.status, needsScheduleCompletion: plan.needs_schedule_completion ?? undefined,
      installments: children(entries.rows, 'movement_id', parent.id).map(row => ({ index: row.installment_index,
        month: row.month, amountMinor: number(row.amount_minor), status: row.status,
        occurredOn: row.occurred_on == null ? undefined : (row.occurred_on instanceof Date
          ? row.occurred_on.toISOString() : String(row.occurred_on)).slice(0, 10),
        confirmedAt: iso(row.confirmed_at), evidenceObservationId: row.evidence_identity ?? undefined,
      })) } : undefined;
    const expected = { id: parent.id, institution: parent.institution, eventType: parent.event_type, status: parent.status,
      amount: { amountMinor: number(parent.amount_minor), currency: parent.currency }, merchantRaw: parent.merchant_raw,
      occurredAt: iso(parent.occurred_at), receivedAt: iso(parent.received_at), ingestedAt: iso(parent.ingested_at),
      categoryId: parent.category_id ?? null, personalAmountMinor: number(parent.personal_amount_minor),
      accountName: parent.account_name ?? 'Tarjeta sin identificar', tags: movementTags.map(row => row.tag),
      parseWarnings: movementWarnings.map(row => row.message), source: source(primary), parserVersion: primary.parser_version,
      captureSource: primary.capture_source, captureSources: captures.map(row => row.capture_source), observationCount: captures.length,
      hasRawEmail: captures.some(row => row.capture_source === 'email'), reconciledAt: iso(parent.reconciled_at), msi: expectedPlan,
      billingPeriod: parent.billing_period ?? undefined, paymentMethodLastFour: parent.payment_method_last_four ?? undefined,
    };
    const detail = await readDetail(String(parent.id)); details++;
    check(expected, pick(detail ?? {}, Object.keys(expected)));
    // Audit order follows reconciliation time, whereas capture summaries follow insertion order.
    const ordered = [...captures].sort((a, b) => iso(a.reconciliation_at)! > iso(b.reconciliation_at)! ? -1
      : iso(a.reconciliation_at)! < iso(b.reconciliation_at)! ? 1 : String(b.id).localeCompare(String(a.id)));
    check(ordered.map(observationFacts), detail?.observations);
    check(children(revisions.rows, 'movement_id', parent.id).map(row => ({ id: row.id, observedPurchaseId: row.movement_id,
      createdAt: iso(row.created_at), changedBy: row.changed_by, changes: row.changes, reason: row.reason ?? undefined,
      source: row.source ?? undefined, operationId: row.operation_id ?? undefined,
    })), detail?.revisions);
    const current = movements.find(row => row.id === parent.id);
    // allStoredEvents includes domain assertions beyond the public detail contract.
    const internalFacts: JsonObject = { account: account(parent), primaryObservationId: parent.primary_observation_id };
    for (const [field, column] of Object.entries({ bankTransactionId: 'bank_transaction_id', sourceMessageId: 'source_message_id',
      counterparty: 'counterparty', trackingKey: 'tracking_key', folio: 'folio', reference: 'reference', transferType: 'transfer_type',
      counterpartyInstitution: 'counterparty_institution', counterpartyAccountLastFour: 'counterparty_account_last_four' }))
      internalFacts[field] = parent[column] ?? undefined;
    check(internalFacts, pick(current ?? {}, Object.keys(internalFacts)));
    const publicFields = Object.keys(expected).filter(field => field !== 'accountName');
    const normalizedCurrent = { ...current, categoryId: current?.categoryId ?? null };
    check(pick(expected, publicFields), pick(normalizedCurrent, publicFields));
  }
  const monthMemberships = (await client.query('SELECT movement_id,month FROM olbia.movement_months ORDER BY movement_id,month')).rows;
  const expectedMemberships = new Set(movements.flatMap(movement => [spendMonthOf(movement),
    ...(((movement.msi as JsonObject | undefined)?.installments ?? []) as JsonObject[]).map(entry => String(entry.month))]
    .map(month => `${movement.id}|${month}`)));
  check([...expectedMemberships].sort(), monthMemberships.map(row => `${row.movement_id}|${row.month}`).sort());
  const unsupportedActiveCurrencies = parents.rows.filter(row => !['rejected', 'deferred_msi', 'pending_foreign'].includes(String(row.status))
    && row.currency !== 'MXN').length;
  check(0, unsupportedActiveCurrencies);
  return { movements: parents.rows.length, observations: observations.rows.length, revisions: revisions.rows.length,
    plans: plans.rows.length, installments: entries.rows.length, details, validatedRelations: constraints.rows.filter(row => row.convalidated === true).length,
    monthMemberships: monthMemberships.length, unsupportedActiveCurrencies, mismatches };
};

/** Financial sums use SQL facts directly, including incomplete schedules and personal zero. */
export const verifyNativeMonthSummary = async (client: ReadSqlClient, month: string, feed: EventFeed, summary: MonthSummary) => {
  const row = (await client.query(`WITH active AS (
    SELECT m.*,p.movement_id AS plan_id,p.needs_schedule_completion,
      to_char(COALESCE(m.occurred_at,m.received_at) AT TIME ZONE 'America/Chihuahua','YYYY-MM') AS financial_month
    FROM olbia.ledger_movements m LEFT JOIN olbia.installment_plans p ON p.movement_id=m.id
    WHERE m.status NOT IN ('rejected','deferred_msi','pending_foreign')
  ), discretionary AS (
    SELECT COALESCE(sum(COALESCE(personal_amount_minor,amount_minor)),0) AS spent,
      COALESCE(sum(CASE WHEN status='needs_review' THEN COALESCE(personal_amount_minor,amount_minor) ELSE 0 END),0) AS uncertain
    FROM active WHERE plan_id IS NULL AND financial_month=$1
  ), installments AS (
    SELECT COALESCE(sum(CASE WHEN i.status='spent' THEN i.amount_minor ELSE 0 END),0) AS spent,
      COALESCE(sum(CASE WHEN i.status='committed' AND a.needs_schedule_completion IS NOT TRUE THEN i.amount_minor ELSE 0 END),0) AS committed,
      COALESCE(sum(CASE WHEN i.status='spent' AND a.status='needs_review' THEN i.amount_minor ELSE 0 END),0) AS uncertain
    FROM active a JOIN olbia.installment_entries i ON i.movement_id=a.id WHERE i.month=$1
  ) SELECT discretionary.spent AS discretionary, installments.spent AS msi_spent,
    installments.committed AS msi_committed, discretionary.uncertain+installments.uncertain AS uncertain
    FROM discretionary CROSS JOIN installments`, [month])).rows[0];
  const expected = { discretionarySpentMinor: Number(row.discretionary), msiSpentMinor: Number(row.msi_spent),
    msiCommittedMinor: Number(row.msi_committed), uncertainMinor: Number(row.uncertain),
    spentMinor: Number(row.discretionary) + Number(row.msi_spent) };
  const membership = (await client.query(`SELECT m.id,
      to_char(COALESCE(m.occurred_at,m.received_at) AT TIME ZONE 'America/Chihuahua','YYYY-MM') AS financial_month
    FROM olbia.ledger_movements m WHERE
      to_char(COALESCE(m.occurred_at,m.received_at) AT TIME ZONE 'America/Chihuahua','YYYY-MM')=$1 OR
      EXISTS(SELECT 1 FROM olbia.installment_entries i WHERE i.movement_id=m.id AND i.month=$1)
    ORDER BY COALESCE(m.occurred_at,m.received_at) DESC,m.id DESC`, [month])).rows;
  const direct = membership.filter(row => row.financial_month === month).map(row => row.id);
  const related = membership.filter(row => row.financial_month !== month).sort((a, b) => {
    const am = String(a.financial_month), bm = String(b.financial_month);
    if (am === bm) return 0;
    if ((am < month) !== (bm < month)) return am < month ? -1 : 1;
    return am < month ? bm.localeCompare(am) : am.localeCompare(bm);
  }).map(row => row.id);
  return { mismatches: Number(!samePublicResult(expected, pick(summary as unknown as JsonObject, Object.keys(expected))))
    + Number(!samePublicResult(direct, feed.events.map(event => event.id)))
    + Number(!samePublicResult(related, feed.msiRelated.map(event => event.id))) };
};
