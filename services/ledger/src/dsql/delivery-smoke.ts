import type { SqlClient } from './projection.js';
import { readMonthlyDelivery, insertMonthlyDeliveryPreparation, insertMonthlyDeliveryReceipt } from './delivery.js';

/** Caller rolls back all work; no SES, Bedrock, rendering or mutation of originals. */
export const smokeNativeDeliveries = async (client:SqlClient,owner:string):Promise<void> => {
  if(!(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=17')).rows.length)throw new Error('Native monthly deliveries are not active');
  let month='';
  for(let year=9999;year>9989;year--){const candidate=`${year}-12`;if(!await readMonthlyDelivery(client,owner,'month_end_reminder',candidate)){month=candidate;break;}}
  if(!month)throw new Error('No rollback verification month available');
  const preparedAt=new Date().toISOString(),email={subject:'SQL rollback verification',html:'SQL rollback verification',text:'SQL rollback verification'};
  await insertMonthlyDeliveryPreparation(client,{kind:'month_end_reminder',owner,month,asOfDay:`${month}-31`,preparedAt,email});
  const prepared=await readMonthlyDelivery(client,owner,'month_end_reminder',month);
  if(prepared?.status!=='prepared'||prepared.preparedAt!==preparedAt||prepared.email.text!==email.text)throw new Error('Native monthly preparation failed');
  await insertMonthlyDeliveryReceipt(client,{kind:'month_end_reminder',owner,month,sentAt:preparedAt,messageId:'sql-rollback-verification'});
  const sent=await readMonthlyDelivery(client,owner,'month_end_reminder',month);
  if(sent?.status!=='sent'||sent.messageId!=='sql-rollback-verification'||sent.contentSha256!==prepared.contentSha256||sent.sentAt!==preparedAt)throw new Error('Native monthly receipt failed');
};
