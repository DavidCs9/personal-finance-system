import { PGlite } from '@electric-sql/pglite';
import { beforeAll,beforeEach,afterAll,expect,it,vi } from 'vitest';
import type { SqlClient,TransactionPool } from '../src/dsql/projection.js';
const harness=vi.hoisted(()=>({pool:undefined as unknown as SqlClient&TransactionPool}));
vi.mock('../src/dsql/connection.js',()=>({createPool:()=>harness.pool}));
import { applicationSqlClient,currentSqlClient,withSqlClient,runSqlTransaction,withSqlTransaction,assertSqlMutationsAvailable } from '../src/dsql/sql-runtime.js';
let sql:PGlite,transactions=0;
beforeAll(async()=>{sql=new PGlite();await sql.exec(`CREATE SCHEMA olbia;
 CREATE TABLE olbia.runtime_state(id text PRIMARY KEY,mode text NOT NULL);INSERT INTO olbia.runtime_state VALUES ('storage','sql');
 CREATE TABLE olbia.application_barrier(id text PRIMARY KEY,generation bigint NOT NULL);INSERT INTO olbia.application_barrier VALUES ('storage',0);
 CREATE TABLE olbia.native_facts(id text PRIMARY KEY,value text NOT NULL)`);
 harness.pool={query:(s,v)=>sql.query<Record<string,unknown>>(s,v),transaction:fn=>{transactions++;return sql.transaction(c=>fn(c as unknown as SqlClient));}};
},30_000);
afterAll(()=>sql.close());beforeEach(async()=>{transactions=0;await sql.exec("TRUNCATE olbia.native_facts;UPDATE olbia.application_barrier SET generation=0;UPDATE olbia.runtime_state SET mode='sql'");});
it('commits nested native operations under one connector transaction and one shared barrier',async()=>{
 await withSqlTransaction(async outer=>{expect(applicationSqlClient()).toBe(outer);expect(currentSqlClient()).toBe(outer);
  await outer.query("INSERT INTO olbia.native_facts VALUES ('first','original')");
  await withSqlTransaction(async inner=>{expect(inner).toBe(outer);await inner.query("INSERT INTO olbia.native_facts VALUES ('second','original')");});});
 expect(transactions).toBe(1);expect(currentSqlClient()).toBeUndefined();expect((await sql.query('SELECT * FROM olbia.native_facts')).rows).toHaveLength(2);
 expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual([{generation:1}]);
});
it('rolls back every nested native fact and the barrier on an enclosing failure',async()=>{
 const failure=new Error('Enclosing native operation failed');
 await expect(withSqlTransaction(async c=>{await c.query("INSERT INTO olbia.native_facts VALUES ('first','original')");await withSqlTransaction(async inner=>{await inner.query("INSERT INTO olbia.native_facts VALUES ('second','original')");throw failure;});})).rejects.toBe(failure);
 expect(currentSqlClient()).toBeUndefined();expect((await sql.query('SELECT * FROM olbia.native_facts')).rows).toEqual([]);expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual([{generation:0}]);
});
it('delegates callback retry to the connector and never reuses an aborted transaction context',async()=>{
 let callbacks=0;const aborted=new Error('Simulated native connector conflict');
 const provider:TransactionPool={transaction:async fn=>{await expect(sql.transaction(async c=>{await fn(c as unknown as SqlClient);throw aborted;})).rejects.toBe(aborted);expect(currentSqlClient()).toBeUndefined();return sql.transaction(c=>fn(c as unknown as SqlClient));}};
 await runSqlTransaction(provider,async c=>{callbacks++;expect(currentSqlClient()).toBe(c);await c.query("INSERT INTO olbia.native_facts VALUES ('original','prepared')");});
 expect(callbacks).toBe(2);expect((await sql.query('SELECT * FROM olbia.native_facts')).rows).toEqual([{id:'original',value:'prepared'}]);expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual([{generation:1}]);
});
it.each(['paused','dynamodb'])('rejects %s before a domain callback or provider side effect, even with obsolete flags',async mode=>{
 await sql.query("UPDATE olbia.runtime_state SET mode=$1",[mode]);vi.stubEnv('OLBIA_SQL_STORE_ENABLED','false');const effect=vi.fn();
 try{await expect(withSqlTransaction(async()=>{effect();})).rejects.toMatchObject({name:'MigrationPausedException'});await expect(assertSqlMutationsAvailable()).rejects.toMatchObject({name:'MigrationPausedException'});expect(effect).not.toHaveBeenCalled();expect((await sql.query('SELECT generation FROM olbia.application_barrier')).rows).toEqual([{generation:0}]);}finally{vi.unstubAllEnvs();}
});
it('sanitizes database failures without retrying arbitrary errors or exposing private driver values',async()=>{
 const operation=vi.fn(async()=>{throw Object.assign(new Error('private financial source'),{code:'42601',detail:'private original'});});
 await expect(withSqlTransaction(operation)).rejects.toMatchObject({name:'StorageUnavailableException',message:'Olbia storage is unavailable.'});expect(operation).toHaveBeenCalledTimes(1);expect((await sql.query('SELECT * FROM olbia.native_facts')).rows).toEqual([]);
});
it('keeps the scoped read client without metadata configuration or a second transaction',async()=>{
 vi.stubEnv('METADATA_TABLE_NAME','');vi.stubEnv('OLBIA_SQL_STORE_ENABLED','false');
 try{await withSqlClient(harness.pool,async()=>{expect(applicationSqlClient()).toBe(harness.pool);await withSqlTransaction(c=>c.query('SELECT * FROM olbia.native_facts'));});expect(transactions).toBe(0);expect(currentSqlClient()).toBeUndefined();}finally{vi.unstubAllEnvs();}
});
