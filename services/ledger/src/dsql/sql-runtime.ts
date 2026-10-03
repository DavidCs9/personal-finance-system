import { AsyncLocalStorage } from 'node:async_hooks';
import { createPool } from './connection.js';
import type { SqlClient,TransactionPool } from './projection.js';

export type StorageAuthority='dynamodb'|'paused'|'sql';
let pool:ReturnType<typeof createPool>|undefined;
const applicationPool=()=>pool??=createPool(process.env.OLBIA_SQL_ROLE??'olbia_application');
const context=new AsyncLocalStorage<SqlClient>();
export const withSqlClient=<T>(client:SqlClient,callback:()=>Promise<T>):Promise<T>=>context.run(client,callback);
export const applicationSqlClient=():SqlClient=>context.getStore()??applicationPool();
export const currentSqlClient=():SqlClient|undefined=>context.getStore();
const paused=()=>Object.assign(new Error('Olbia está en mantenimiento. Intenta de nuevo más tarde.'),{name:'MigrationPausedException'});
const unavailable=()=>Object.assign(new Error('Olbia storage is unavailable.'),{name:'StorageUnavailableException'});

/** Persisted control is retained for explicitly reviewed recovery; products never fall back. */
export const readStorageAuthority=async(client:SqlClient):Promise<StorageAuthority>=>{
  const mode=(await client.query("SELECT mode FROM olbia.runtime_state WHERE id='storage'")).rows[0]?.mode;
  if(!['dynamodb','paused','sql'].includes(String(mode)))throw unavailable();return mode as StorageAuthority;
};
export const assertSqlMutationsAvailable=async(client:SqlClient=applicationSqlClient()):Promise<void>=>{
  try{if(await readStorageAuthority(client)!=='sql')throw paused();}
  catch(error){if((error as {code?:string}).code)throw unavailable();throw error;}
};

/** One shared domain transaction/barrier. Native connector owns rollback and OCC retries. */
export const runSqlTransaction=async<T>(transactionPool:TransactionPool,callback:(client:SqlClient)=>Promise<T>):Promise<T>=>{
  const existing=context.getStore();if(existing)return callback(existing);
  return transactionPool.transaction(async client=>{
    await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
    await assertSqlMutationsAvailable(client);
    return withSqlClient(client,()=>callback(client));
  });
};
export const withSqlTransaction=async<T>(callback:(client:SqlClient)=>Promise<T>):Promise<T>=>{
  const existing=context.getStore();if(existing)return callback(existing);
  try{return await runSqlTransaction(applicationPool(),callback);}
  catch(error){if((error as {code?:string}).code)throw unavailable();throw error;}
};
