import { applicationStoreClient, withNativeTransaction } from '@finance/ledger/dsql-store';
import { readMonthlyDelivery, validateMonthlyDeliveryPreparation, insertMonthlyDeliveryPreparation, insertMonthlyDeliveryReceipt,
  type MonthlyDeliveryPreparation, type MonthlyDeliveryKind } from '@finance/ledger/native-deliveries';

/** One native read statement includes the immutable preparation and any provider receipt. */
export const getMonthlyEmailDelivery = async (owner:string,kind:MonthlyDeliveryKind,month:string) => {
  try { return await readMonthlyDelivery(applicationStoreClient(),owner,kind,month); }
  catch { throw Object.assign(new Error('Olbia storage is unavailable.'),{name:'StorageUnavailableException'}); }
};
export const prepareMonthlyEmailDelivery = async (input:MonthlyDeliveryPreparation):Promise<void> => {
  validateMonthlyDeliveryPreparation(input);
  await withNativeTransaction(client=>insertMonthlyDeliveryPreparation(client,input));
};
export const markMonthlyEmailAccepted = async (input:{readonly owner:string;readonly kind:MonthlyDeliveryKind;readonly month:string;readonly messageId:string;readonly sentAt:string}):Promise<void> =>
  withNativeTransaction(client=>insertMonthlyDeliveryReceipt(client,input));
