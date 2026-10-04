import { addCalendarMonths, clampDayInMonth, isValidMonth, monthKeyInZone,
  type CommitmentItem, type CommitmentMonth, type FutureCommitments } from '@finance/domain';
import { readerPool, withLedgerReadSnapshot, type ReadSqlClient } from '../events/sql-reads.js';
import { InvalidMonthlyPlanError } from './monthly-plan.js';

/** Totals and detail share one relation, avoiding multiplication of MSI by fixed payments. */
export const commitmentsReadStatement = `WITH requested AS (
  SELECT unnest($1::text[]) AS month
), effective_plans AS (
  SELECT r.month, MAX(p.month) AS source_month FROM requested r
  LEFT JOIN olbia.month_plans p ON p.owner=$2 AND p.month<=r.month GROUP BY r.month
), entries AS (
  SELECT i.month,'msi'::text AS kind,m.id::text AS id,m.merchant_raw AS name,i.amount_minor,
    m.status='needs_review' AS needs_review,NULL::integer AS due_day,
    i.installment_index,p.months AS installments,
    (SELECT MAX(last.month) FROM olbia.installment_entries last WHERE last.movement_id=m.id AND last.status<>'cancelled') AS end_month,
    i.installment_index AS sort_order
  FROM olbia.installment_entries i
  JOIN olbia.installment_plans p ON p.movement_id=i.movement_id
  JOIN olbia.ledger_movements m ON m.id=i.movement_id
  WHERE i.month=ANY($1::text[]) AND i.status='committed'
    AND m.status IN ('accepted','needs_review') AND m.currency='MXN'
    AND p.needs_schedule_completion IS NOT TRUE
  UNION ALL
  SELECT e.month,'fixed',p.id,p.name,p.amount_mxn_minor,false,p.due_day,
    NULL::integer,NULL::integer,NULL::text,p.sort_order
  FROM effective_plans e JOIN olbia.planned_payments p ON p.month=e.source_month
), totals AS (
  SELECT r.month,COALESCE(SUM(e.amount_minor),0) AS total_minor,
    COALESCE(SUM(CASE WHEN e.kind='msi' THEN e.amount_minor ELSE 0 END),0) AS msi_minor,
    COALESCE(SUM(CASE WHEN e.kind='fixed' THEN e.amount_minor ELSE 0 END),0) AS fixed_minor,
    COALESCE(SUM(CASE WHEN e.needs_review THEN e.amount_minor ELSE 0 END),0) AS uncertain_minor,
    COUNT(CASE WHEN e.kind='msi' THEN 1 END) AS installment_count
  FROM requested r LEFT JOIN entries e ON e.month=r.month GROUP BY r.month
), changes AS (
  SELECT t.*,CASE WHEN t.month<=$3 THEN NULL ELSE t.total_minor-LAG(t.total_minor) OVER (ORDER BY t.month) END AS change_minor
  FROM totals t
)
SELECT t.*,p.source_month,e.kind,e.id,e.name,e.amount_minor,e.needs_review,e.due_day,
  e.installment_index,e.installments,e.end_month
FROM changes t JOIN effective_plans p ON p.month=t.month
LEFT JOIN entries e ON e.month=t.month ORDER BY t.month,e.kind,e.sort_order,e.name,e.id`;

export const incompletePlansReadStatement = `SELECT m.id AS event_id,m.merchant_raw AS name
  FROM olbia.installment_plans p JOIN olbia.ledger_movements m ON m.id=p.movement_id
  WHERE p.needs_schedule_completion IS TRUE
    AND m.status IN ('accepted','needs_review') AND m.currency='MXN' ORDER BY m.merchant_raw,m.id`;

const integer = (value: unknown): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Commitment amount exceeds supported precision.');
  return result;
};

const validateStart = (startMonth: string | undefined, now: Date): string => {
  const currentMonth = monthKeyInZone(now);
  const start = startMonth ?? currentMonth;
  if (!isValidMonth(start) || start<currentMonth || start>addCalendarMonths(currentMonth, 120)) {
    throw new InvalidMonthlyPlanError('Elige un mes actual o futuro dentro de los próximos diez años.');
  }
  return start;
};

export const readFutureCommitments = async (owner: string, startMonth: string | undefined, now: Date,
  client: ReadSqlClient): Promise<FutureCommitments> => {
  const currentMonth = monthKeyInZone(now);
  const start = validateStart(startMonth, now);
  const limit = addCalendarMonths(currentMonth, 120);
  const months = Array.from({ length: 12 }, (_, index) => addCalendarMonths(start, index));
  const rows = (await client.query(commitmentsReadStatement, [months, owner, addCalendarMonths(currentMonth, 1)])).rows;
  const incomplete = (await client.query(incompletePlansReadStatement)).rows;
  const grouped = new Map<string, CommitmentMonth & { items: CommitmentItem[] }>();
  for (const row of rows) {
    const month = String(row.month);
    let result = grouped.get(month);
    if (!result) {
      result = { month, totalMinor: integer(row.total_minor), msiMinor: integer(row.msi_minor),
        fixedMinor: integer(row.fixed_minor), uncertainMinor: integer(row.uncertain_minor),
        installmentCount: integer(row.installment_count),
        changeMinor: row.change_minor === null ? null : integer(row.change_minor),
        fixedSourceMonth: row.source_month === null ? null : String(row.source_month), items: [] };
      grouped.set(month, result);
    }
    if (row.kind === null) continue;
    result.items.push({ kind: row.kind as CommitmentItem['kind'], id: String(row.id), name: String(row.name),
      amountMinor: integer(row.amount_minor), needsReview: row.needs_review === true,
      ...(row.kind === 'fixed' ? { dueDay: clampDayInMonth(integer(row.due_day), month) } : {
        installmentIndex: integer(row.installment_index), installments: integer(row.installments), endMonth: String(row.end_month),
      }) });
  }
  const next = addCalendarMonths(start, 12);
  return { currency: 'MXN', currentMonth, generatedAt: now.toISOString(), months: [...grouped.values()],
    ...(next<=limit ? { nextStartMonth: next } : {}),
    incompletePlans: incomplete.map(row => ({ eventId: String(row.event_id), name: String(row.name) })) };
};

export const getFutureCommitments = (owner: string, startMonth?: string): Promise<FutureCommitments> => {
  const now = new Date();
  validateStart(startMonth, now);
  return withLedgerReadSnapshot(() => readFutureCommitments(owner, startMonth, now, readerPool()));
};
