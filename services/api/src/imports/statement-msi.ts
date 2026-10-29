import {addCalendarMonths,amountsWithinTolerance,dayKeyInZone,type MsiPlan} from '@finance/domain';
import {amexMerchantsMatch,hasCompleteMsiPlanEvidence,isAutomaticAmexLabel,matchEvidenceLine as matchMsiEvidence,type EvidenceLine} from './msi-reconciliation.js';
import type {StatementPreviewRow,ExpectedManualPlan} from './statement-reconciliation.js';
import type {BankMsiAssertion} from './bank-ledger.js';
import type {JsonObject} from '../http/response.js';
const matchEvidenceLine=(line:EvidenceLine,events:readonly JsonObject[])=>matchMsiEvidence(line,events,{trustLegacyEvidenceIdentity:false});

/** This is an offered, explicit correction; approximate amounts never establish purchase identity. */
export const manualPlanSnapshotForStatement = (line: EvidenceLine, event: JsonObject,
  scope: {readonly institution:string;readonly accountLastFour:string}): ExpectedManualPlan | undefined => {
  const plan = event.msi as MsiPlan | undefined;
  const amount = event.amount as JsonObject | undefined, account = event.account as JsonObject | undefined;
  const occurredAt = typeof event.occurredAt === 'string' ? event.occurredAt : undefined;
  if (!hasCompleteMsiPlanEvidence(line) || !line.originalOn || !occurredAt || !Number.isFinite(new Date(occurredAt).getTime())
    || dayKeyInZone(new Date(occurredAt)) !== line.originalOn || event.captureSource !== 'manual'
    || !['accepted','needs_review'].includes(String(event.status)) || event.institution !== scope.institution
    || amount?.currency !== 'MXN' || event.personalAmountMinor !== undefined || !plan || plan.needsScheduleCompletion
    || plan.months !== line.installmentMonths || plan.installments.length !== plan.months
    || !['active','completed'].includes(plan.status)
    || plan.installments.some((item,index)=>item.index !== index+1 || item.status === 'cancelled'
      || item.month !== addCalendarMonths(plan.installments[0]!.month,index))
    || ((event.bankMsiAssertions ?? []) as BankMsiAssertion[]).length > 0
    || event.hasUnresolvedBankMsiEvidence === true
    || account?.lastFour && account.lastFour !== scope.accountLastFour
    || amount.amountMinor !== plan.principalMinor
    || Math.abs(plan.principalMinor-line.originalAmountMinor!) > Math.max(200,Math.round(line.originalAmountMinor!/100))) return undefined;
  return {principalMinor:plan.principalMinor,cuotaMinor:plan.cuotaMinor,months:plan.months,
    startMonth:plan.installments[0]!.month,occurredAt,accountLastFour:typeof account?.lastFour === 'string' ? account.lastFour : null};
};

export const classifyMsiEvidenceRow = (
  line: EvidenceLine,
  events: readonly JsonObject[],
  scope: { readonly institution: string; readonly accountLastFour: string },
): StatementPreviewRow => {
  const scoped = statementMsiEvents(events, scope);
  const match = matchEvidenceLine(line, scoped);
  const conflicts = statementMsiConflicts(line, events, scope);
  const base = { identity: line.identity, kind: 'msi' as const, merchantRaw: line.merchantRaw,
    amountMinor: line.amountMinor, occurredOn: line.occurredOn, msi: true,
    installmentIndex: line.installmentIndex, installmentMonths: line.installmentMonths,
    originalAmountMinor: line.originalAmountMinor, originalOn: line.originalOn, merchantReference: line.merchantReference };
  if (conflicts.length) {
    const relevant = new Set(conflicts.map(event => String(event.id)));
    if (match.kind === 'confirm') relevant.add(match.eventId);
    if (match.kind === 'needs_decision') for (const candidate of match.candidates) relevant.add(candidate.eventId);
    const candidates = events.filter(event => relevant.has(String(event.id))).map(event => statementPlanCandidate(event,line,scope));
    return { ...base, status: 'needs_decision', reason: 'conflicting_msi_plan',
      candidateEventIds: candidates.map(candidate => candidate.id), candidates };
  }
  if (match.kind === 'confirm') {
    return {
      identity: line.identity,
      kind: 'msi',
      merchantRaw: line.merchantRaw,
      amountMinor: line.amountMinor,
      occurredOn: line.occurredOn,
      msi: true,
      installmentIndex: line.installmentIndex,
      installmentMonths: line.installmentMonths,
      originalAmountMinor: line.originalAmountMinor,
      originalOn: line.originalOn,
      merchantReference: line.merchantReference,
      status: 'matched',
      eventId: match.eventId,
      candidateEventIds: [match.eventId],
      candidates: events.filter(event => event.id === match.eventId).map(event => statementPlanCandidate(event,line,scope)),
    };
  }
  if (match.kind === 'needs_decision') {
    const candidateIds = new Set(match.candidates.map(candidate => candidate.eventId));
    const candidates = events.filter(event => candidateIds.has(String(event.id))).map(event => statementPlanCandidate(event,line,scope));
    if (match.reason === 'no_matching_plan' && candidates.length === 0 && hasCompleteMsiPlanEvidence(line))
      return { ...base, status: 'new', candidateEventIds: [], candidates: [] };
    return {
      identity: line.identity,
      kind: 'msi',
      merchantRaw: line.merchantRaw,
      amountMinor: line.amountMinor,
      occurredOn: line.occurredOn,
      msi: true,
      installmentIndex: line.installmentIndex,
      installmentMonths: line.installmentMonths,
      originalAmountMinor: line.originalAmountMinor,
      originalOn: line.originalOn,
      merchantReference: line.merchantReference,
      status: 'needs_decision',
      reason: match.reason === 'ambiguous_msi_match' ? 'ambiguous_msi_match' : 'incomplete_msi_schedule',
      candidateEventIds: candidates.map((candidate) => candidate.id),
      candidates,
    };
  }
  return {
    identity: line.identity,
    kind: 'msi',
    merchantRaw: line.merchantRaw,
    amountMinor: line.amountMinor,
    occurredOn: line.occurredOn,
    msi: true,
    installmentIndex: line.installmentIndex,
    installmentMonths: line.installmentMonths,
    originalAmountMinor: line.originalAmountMinor,
    status: 'skipped',
    candidateEventIds: [],
    candidates: [],
  };
};

/** Only an observed bank/card/currency relationship permits an automatic MSI match. */
export const statementMsiEvents = (events: readonly JsonObject[], scope: { readonly institution: string; readonly accountLastFour: string }): readonly JsonObject[] =>
  events.flatMap(event => {
    if (event.institution !== scope.institution || (event.amount as JsonObject | undefined)?.currency !== 'MXN') return [];
    const assertions = (Array.isArray(event.bankMsiAssertions) ? event.bankMsiAssertions : []) as BankMsiAssertion[];
    const matching = assertions.filter(assertion => assertion.institution === scope.institution && assertion.accountLastFour === scope.accountLastFour);
    const card = (event.account as JsonObject | undefined)?.lastFour;
    if (card && card !== scope.accountLastFour || !card && matching.length === 0) return [];
    return [{...event, msiMerchantAliases: matching.map(assertion => assertion.merchantRaw),
      msiCommercialReferences: matching.flatMap(assertion => assertion.merchantReference ? [assertion.merchantReference] : [])}];
  });

const statementPlanCandidate = (event: JsonObject,line:EvidenceLine,scope:{readonly institution:string;readonly accountLastFour:string}) => {
  const plan = event.msi as MsiPlan | undefined;
  const amount = event.amount as JsonObject | undefined;
  const expectedPlan = manualPlanSnapshotForStatement(line,event,scope);
  return { id: String(event.id), merchantRaw: String(event.merchantRaw ?? ''),
    ...(expectedPlan ? {canReconcilePlan:true,expectedPlan} : {}),
    ...(typeof event.occurredAt === 'string' ? { occurredAt: event.occurredAt } : {}),
    ...(plan ? { months: plan.months, cuotaMinor: plan.cuotaMinor, principalMinor: plan.principalMinor }
      : typeof amount?.amountMinor === 'number' ? { principalMinor: amount.amountMinor } : {}) };
};

/** Plausible contradictory/manual captures block creation; they never establish identity. */
const statementMsiConflicts = (line: EvidenceLine, events: readonly JsonObject[], scope: { readonly institution: string; readonly accountLastFour: string }): readonly JsonObject[] =>
  events.filter(event => {
    if (event.status === 'rejected' || event.institution !== scope.institution
      || (event.amount as JsonObject | undefined)?.currency !== 'MXN') return false;
    const account = event.account as JsonObject | undefined;
    if (account?.lastFour && account.lastFour !== scope.accountLastFour) return false;
    const plan = event.msi as MsiPlan | undefined;
    const hasBankRelationship = ((event.bankMsiAssertions ?? []) as BankMsiAssertion[]).some(assertion =>
      assertion.institution === scope.institution && assertion.accountLastFour === scope.accountLastFour);
    const bankReferences = ((event.bankMsiAssertions ?? []) as BankMsiAssertion[]).filter(assertion =>
      assertion.institution === scope.institution && assertion.accountLastFour === scope.accountLastFour)
      .flatMap(assertion => assertion.merchantReference ? [assertion.merchantReference] : []);
    const principal = plan?.principalMinor ?? Number((event.amount as JsonObject | undefined)?.amountMinor);
    const amountClose = line.originalAmountMinor !== undefined && amountsWithinTolerance(principal, line.originalAmountMinor);
    const merchant = !isAutomaticAmexLabel(line.merchantRaw) && amexMerchantsMatch(String(event.merchantRaw ?? ''), line.merchantRaw);
    const actualDay = typeof event.occurredAt === 'string' && Number.isFinite(new Date(event.occurredAt).getTime())
      ? dayKeyInZone(new Date(event.occurredAt)) : undefined;
    const sameOriginalDay = Boolean(line.originalOn && line.originalOn === actualDay);
    if (line.merchantReference && bankReferences.length && !bankReferences.includes(line.merchantReference)
      && amountClose && plan?.months === line.installmentMonths) return true;
    // A 1% neighbourhood is only a guard against duplicate manual estimates, never an auto-link tolerance.
    const estimatedPrincipal = line.originalAmountMinor ?? (line.installmentMonths ? line.amountMinor*line.installmentMonths : undefined);
    const sameManualCalendar = sameOriginalDay || line.originalAmountMinor === undefined && line.installmentIndex
      && plan?.installments[0]?.month === addCalendarMonths(line.occurredOn.slice(0,7),-(line.installmentIndex-1));
    // Excel can omit the original principal/date. An estimate may block a second
    // plan; it never supplies bank terms or establishes purchase identity.
    const approximateManual = !account?.lastFour && plan?.months === line.installmentMonths && sameManualCalendar
      && Number.isSafeInteger(estimatedPrincipal) && Number.isSafeInteger(principal)
      && Math.abs(principal-estimatedPrincipal!) <= Math.max(200,Math.round(estimatedPrincipal!/100));
    if (!account?.lastFour && !hasBankRelationship) return approximateManual || amountClose && (merchant || sameOriginalDay);
    const automatic = isAutomaticAmexLabel(line.merchantRaw);
    if (!merchant || !plan) {
      const target = plan?.installments.find(item => item.index === line.installmentIndex);
      return Boolean(merchant && amountClose && sameOriginalDay || automatic && amountClose && plan
        && plan.months === line.installmentMonths && target?.month === line.occurredOn.slice(0, 7)
        && (plan.needsScheduleCompletion || target?.status === 'cancelled'));
    }
    const target = plan.installments.find(item => item.index === line.installmentIndex);
    const otherwiseCompatible = !plan.needsScheduleCompletion && plan.months === line.installmentMonths
      && amountsWithinTolerance(plan.cuotaMinor, line.amountMinor) && (line.originalAmountMinor === undefined || amountClose)
      && target && target.status !== 'cancelled';
    return !otherwiseCompatible && (amountClose || Boolean(target && target.month === line.occurredOn.slice(0, 7)));
  });

