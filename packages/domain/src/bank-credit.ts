/** Posted bank evidence. A credit never changes a recorded balance or a purchase. */
export interface BankCredit {
  readonly movementId: string;
  readonly creditType: 'income' | 'refund' | 'fund_release';
  readonly incomeType: 'finiquito' | 'nomina' | 'otro' | null;
  readonly accountKind: 'cash' | 'credit_card';
  readonly institution: 'santander_mx' | 'nu_mx' | 'american_express_mx';
  readonly accountLastFour: string;
  readonly amountMinor: number;
  readonly currency: 'MXN';
  readonly postedOn: string;
  readonly description: string;
  readonly evidenceReference: string;
  readonly fundEmployerKey: string | null;
}
