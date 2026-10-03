import { applicationSqlClient,withSqlTransaction } from '@finance/ledger/sql-runtime';
import { assertNativeExceptionAccess,listReviewExceptions,readReviewException,requestReviewRetry,discardReviewException,publicRetry } from '@finance/ledger/native-exceptions';
import type { JsonObject } from '../http/response.js';
import { readSource } from '../events/queries.js';
import { randomUUID } from 'node:crypto';

export const listExceptions=async(at:Date=new Date()):Promise<readonly JsonObject[]>=>{
  const client=applicationSqlClient();await assertNativeExceptionAccess(client);
  try{return await listReviewExceptions(client,at);}
  catch(error){if((error as {code?:string}).code)throw Object.assign(new Error('Olbia storage is unavailable.'),{name:'StorageUnavailableException'});throw error;}
};
export const requestRetry=async(exceptionId:string,requestedBy:string):Promise<JsonObject>=>{
  const requestedAt=new Date().toISOString(),requestId=randomUUID();
  return withSqlTransaction(async client=>{await assertNativeExceptionAccess(client);
    const retry=await requestReviewRetry(client,exceptionId,requestedAt,requestedBy,requestId);
    return {id:exceptionId,retry:publicRetry(retry)};
  });
};
export const discardException=async(exceptionId:string,discardedBy:string):Promise<JsonObject>=>{
  const discarded={at:new Date().toISOString(),by:discardedBy};
  return withSqlTransaction(async client=>{await assertNativeExceptionAccess(client);
    await discardReviewException(client,exceptionId,discarded.at,discarded.by);return {id:exceptionId,discarded};
  });
};
export const readStoredException=async(exceptionId:string,at:Date=new Date())=>{
  const client=applicationSqlClient();await assertNativeExceptionAccess(client);
  try{return await readReviewException(client,exceptionId,at);}
  catch(error){if((error as {code?:string}).code)throw Object.assign(new Error('Olbia storage is unavailable.'),{name:'StorageUnavailableException'});throw error;}
};
export const readExceptionRawEmail=async(exceptionId:string):Promise<string>=>{
  const exception=await readStoredException(exceptionId);
  if(!exception)throw new Error(`Missing raw source for exception ${exceptionId}`);
  await assertNativeExceptionAccess();return readSource(exception.source,`exception ${exceptionId}`);
};
