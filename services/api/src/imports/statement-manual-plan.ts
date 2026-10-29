import { randomUUID } from 'node:crypto';
import { currentSqlClient } from '@finance/ledger/sql-runtime';
import { confirmManualPlanBankTerms, insertLedgerRevision, LedgerPreconditionError, readLedgerDetail, replaceInstallmentPlan } from '@finance/ledger/native-ledger';
import { bankClaimToken, bankPlanEvidence, linkBankEvidence } from './bank-ledger.js';
import { buildPlanFromCreateDecision } from './msi-reconciliation.js';
import { BankImportError, type BankImportRecord } from './import-sql.js';
import type { ExpectedManualPlan, StatementPreviewRow } from './statement-reconciliation.js';
import {manualPlanSnapshotForStatement} from './statement-msi.js';
import { readSourceClaim } from '@finance/ledger/native-ledger';

/** All current columns, the source claim, history and cuota FK commit in the caller's bank transaction. */
export const reconcileManualPlanFromStatement = async (record:BankImportRecord,row:StatementPreviewRow,eventId:string,
  expected:ExpectedManualPlan,appliedAt:string):Promise<void> => {
  const client=currentSqlClient();
  if(!client)throw new BankImportError('La conciliación requiere una transacción financiera.');
  const institution=record.kind==='amex_statement'?'american_express_mx':'santander_mx';
  const event=await readLedgerDetail(client,eventId);
  const scope={institution,accountLastFour:record.accountLastFour??''};
  const snapshot=event && manualPlanSnapshotForStatement(row,event,scope);
  if(!event || !snapshot || Object.keys(snapshot).some(key=>snapshot[key as keyof ExpectedManualPlan]!==expected[key as keyof ExpectedManualPlan]))
    throw new BankImportError('El plan manual cambió o ya tiene evidencia bancaria. Vuelve a consultar el estado.');
  if(await readSourceClaim(client,record.kind,bankClaimToken(row.identity)))
    throw new BankImportError('Esta cuota ya tiene una decisión conservada. Vuelve a consultar el estado.');
  const account={institution,accountId:`${institution}:${scope.accountLastFour}`,lastFour:scope.accountLastFour,
    displayName:`${record.product??institution} · ${scope.accountLastFour}`};
  const next=buildPlanFromCreateDecision(row,{months:row.installmentMonths!,cuotaMinor:row.amountMinor});
  try {
    await confirmManualPlanBankTerms(client,eventId,expected,{principalMinor:row.originalAmountMinor!,account,
      bankTransactionId:row.transactionId,reconciledAt:appliedAt});
  } catch(error) {
    if(error instanceof LedgerPreconditionError)throw new BankImportError('El plan manual cambió o ya tiene evidencia bancaria. Vuelve a consultar el estado.');
    throw error;
  }
  const linked=await linkBankEvidence({record,row,eventId,appliedAt,account,reason:'Identidad del plan manual confirmada con el estado de cuenta.',
    parserVersion:record.kind==='amex_statement'?'amex-mx-statement-textract-v1':'santander-mx-statement-textract-v1'});
  if(!linked)throw new BankImportError('Esta cuota ya fue conciliada. Vuelve a consultar el estado.');
  await replaceInstallmentPlan(client,eventId,next,bankPlanEvidence(record,row,next));
  await insertLedgerRevision(client,{id:randomUUID(),movementId:eventId,createdAt:appliedAt,changedBy:record.owner,
    reason:'Plan manual conciliado con términos bancarios confirmados por el dueño.',changes:{
      amount:{previous:event.amount,next:{amountMinor:row.originalAmountMinor!,currency:'MXN'}},
      account:{previous:event.account??null,next:account},msi:{previous:event.msi,next},
    }});
};
