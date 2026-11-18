import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dayKeyInZone, financialDay, financialMinor, financialText, FinancialPlanError, type BankCredit } from '@finance/domain';
import { applicationSqlClient } from '@finance/ledger/sql-runtime';
import {
  appendLedgerObservation, insertBankCreditDetails, insertLedgerMovement, insertSourceClaim,
  readBankCredit, readFundCreditTarget, readSourceClaim, type SqlClient,
} from '@finance/ledger/native-ledger';
import { storeManualEvidence } from './manual-entry.js';

type CreditInput = Omit<BankCredit, 'movementId'>;

export const parseManualCredit = (input: Record<string, unknown>, now: Date): CreditInput => {
  const { creditType, institution, accountKind, accountLastFour } = input;
  const incomeType = input.incomeType ?? null;
  if (input.confirmedPosted !== true) throw new FinancialPlanError('Confirma que el banco ya acreditó el abono.');
  if (input.currency !== undefined && input.currency !== 'MXN') throw new FinancialPlanError('El abono debe estar en MXN.');
  if (creditType !== 'income' && creditType !== 'refund' && creditType !== 'fund_release') {
    throw new FinancialPlanError('creditType debe ser income, refund o fund_release.');
  }
  if (institution !== 'santander_mx' && institution !== 'nu_mx' && institution !== 'american_express_mx') {
    throw new FinancialPlanError('Indica una institución de abono soportada.');
  }
  if ((accountKind !== 'cash' && accountKind !== 'credit_card') || institution === 'american_express_mx' && accountKind !== 'credit_card') {
    throw new FinancialPlanError('Identifica si el banco abonó en efectivo o en una tarjeta de crédito.');
  }
  if (typeof accountLastFour !== 'string' || !/^\d{4}$/.test(accountLastFour)) {
    throw new FinancialPlanError('Proporciona los últimos cuatro dígitos de la cuenta o tarjeta acreditada.');
  }
  if (creditType === 'income' &&
    (accountKind !== 'cash' || incomeType !== 'finiquito' && incomeType !== 'nomina' && incomeType !== 'otro')) {
    throw new FinancialPlanError('Un ingreso realizado requiere cuenta de efectivo y tipo finiquito, nomina u otro.');
  }
  if (creditType !== 'income' && incomeType !== null) throw new FinancialPlanError('Sólo income admite un tipo de ingreso.');
  const fundEmployerKey = input.fundEmployerKey ?? null;
  if (creditType === 'fund_release' && (accountKind !== 'cash'
    || typeof fundEmployerKey !== 'string' || !/^[A-Z0-9]{1,200}$/.test(fundEmployerKey))) {
    throw new FinancialPlanError('El Fondo requiere cuenta de efectivo y fundEmployerKey del cierre patrimonial.');
  }
  if (creditType !== 'fund_release' && fundEmployerKey !== null) throw new FinancialPlanError('Usa fundEmployerKey sólo para fund_release.');
  const postedOn = financialDay(input.postedOn);
  if (postedOn > dayKeyInZone(now)) throw new FinancialPlanError('El día del abono no puede ser futuro.');
  const evidenceReference = financialText(input.evidenceReference, 'evidenceReference').normalize('NFKC').replace(/\s+/g, ' ').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9 ._:/-]{3,159}$/.test(evidenceReference)) {
    throw new FinancialPlanError('Proporciona la referencia bancaria verificable del abono (4–160 caracteres).');
  }
  return { creditType, incomeType: incomeType as CreditInput['incomeType'], institution, accountKind, accountLastFour,
    amountMinor: financialMinor(input.amountMinor), currency: 'MXN', postedOn, evidenceReference,
    description: financialText(input.description, 'description'), fundEmployerKey: fundEmployerKey as string | null };
};

const creditToken = (owner: string, credit: CreditInput) => createHash('sha256')
  .update(JSON.stringify(['manual_credit', owner, credit.institution, credit.evidenceReference])).digest('hex');

export const previousManualCredit = async (client: SqlClient, owner: string, input: CreditInput): Promise<BankCredit | null> => {
  const claim = await readSourceClaim(client, 'manual', creditToken(owner, input));
  if (!claim) return null;
  const prior = claim.outcome === 'linked' && claim.owner === owner && claim.movement_id
    ? await readBankCredit(client, owner, String(claim.movement_id)) : null;
  if (prior) {
    const { movementId: _movementId, ...recorded } = prior;
    if (isDeepStrictEqual(recorded, input)) return prior;
  }
  throw new FinancialPlanError('La misma referencia bancaria ya está registrada con otros datos. Verifica el abono original.', 'conflict');
};

export const manualCreditFundEvidence = async (client: SqlClient, owner: string, input: CreditInput, existing: BankCredit | null) => {
  if (!input.fundEmployerKey) return null;
  const fund = await readFundCreditTarget(client, owner, input.fundEmployerKey);
  if (!fund) throw new FinancialPlanError('No existe el cierre del Fondo. Consulta month_snapshot.', 'not_found');
  if (input.postedOn < fund.endedOn || fund.movementId && fund.movementId !== existing?.movementId) {
    throw new FinancialPlanError('El día o movimiento bancario es incompatible con el cierre del Fondo.', 'conflict');
  }
  return { ...fund, bankPostedOn: input.postedOn, bankAmountMinor: input.amountMinor,
    differenceMinor: input.amountMinor - fund.declaredAmountMinor };
};

export const prepareManualCredit = async (
  input: CreditInput, owner: string, identity: { movementId: string; observationId: string },
) => {
  const sql = applicationSqlClient();
  const prior = await previousManualCredit(sql, owner, input);
  await manualCreditFundEvidence(sql, owner, input, prior);
  const token = creditToken(owner, input);
  // Conditional S3 creation is outside the retryable SQL transaction. Same evidence has a stable hash.
  const source = prior ? null : await storeManualEvidence(owner, JSON.stringify({ kind: 'manual_credit', owner, ...input }));
  return async (client: SqlClient, appliedAt: string) => {
    const existing = await previousManualCredit(client, owner, input);
    const fundReconciliation = await manualCreditFundEvidence(client, owner, input, existing);
    if (existing) return { credit: existing, created: false, fundReconciliation };
    if (!source) throw new FinancialPlanError('El abono previo cambió; crea otro preview.', 'conflict');
    const { movementId, observationId } = identity;
    const account = { institution: input.institution, lastFour: input.accountLastFour,
      accountId: `${input.institution}:${input.accountKind}:${input.accountLastFour}` };
    const recorded = { institution: input.institution, eventType: 'bank_credit', account, source,
      amount: { amountMinor: input.amountMinor, currency: input.currency }, merchantRaw: input.description,
      bankTransactionId: input.evidenceReference, parserVersion: 'manual-credit-v1', parseWarnings: [] };
    // postedOn has day precision. Timestamps here describe ingestion, never a fabricated bank time.
    await insertLedgerMovement(client, { ...recorded, id: movementId, status: 'accepted', receivedAt: appliedAt,
      ingestedAt: appliedAt }, observationId, appliedAt);
    await appendLedgerObservation(client, { ...recorded, id: observationId, movementId, captureSource: 'manual',
      observedAt: appliedAt, reconciliationAt: appliedAt });
    const credit = { ...input, movementId };
    await insertBankCreditDetails(client, owner, credit);
    await insertSourceClaim(client, { captureSource: 'manual', token, createdAt: appliedAt, movementId, observationId,
      owner, fingerprint: token });
    return { credit, created: true, fundReconciliation };
  };
};
