import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { SCHEMA_STATEMENTS, bootstrapSchema, ensureNativeControlConstraints, NATIVE_CONTROL_CONSTRAINTS } from '../src/dsql/schema.js';
import { LEDGER_PRIMARY_OBSERVATION_CONSTRAINT } from '../src/dsql/ledger-schema.js';
import type { SqlClient } from '../src/dsql/projection.js';
let sql:PGlite;
const roles=['olbia_application','olbia_cutover','olbia_reader','olbia_store_reader','olbia_operational_verifier','olbia_projector'];
beforeAll(async()=>{
  sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);
  await sql.query(`ALTER TABLE olbia.ledger_movements ADD CONSTRAINT ledger_movements_primary_observation_fk ${LEDGER_PRIMARY_OBSERVATION_CONSTRAINT}`);
  await sql.query("UPDATE olbia.runtime_state SET mode='sql' WHERE id='storage'");
  await sql.query('INSERT INTO olbia.schema_migrations VALUES (14,CURRENT_TIMESTAMP)');
  // Upgrade from the deployed table-wide grants, rather than testing only a clean DB.
  for(const role of roles)await sql.query(`CREATE ROLE ${role} WITH LOGIN`);
  for(const role of ['olbia_application','olbia_cutover','olbia_projector'])await sql.query(`GRANT SELECT,UPDATE ON olbia.application_barrier TO ${role}`);
  await sql.query('GRANT UPDATE ON olbia.runtime_state TO olbia_cutover');
  const client:SqlClient={query:async(s,v)=>{
    if(s.startsWith('AWS IAM GRANT'))return{rows:[]};
    if(s.startsWith('CREATE INDEX ASYNC'))return sql.query(s.replace('INDEX ASYNC','INDEX'),v);
    if(s.startsWith('ALTER TABLE ASYNC')){await sql.query(s.replace('TABLE ASYNC','TABLE'),v);return{rows:[{job_id:'local-validation'}]};}
    return sql.query<Record<string,unknown>>(s,v);
  }};
  const identity=['arn:aws:iam::225989371926:role/control-test'];
  await bootstrapSchema(client,identity,{transactionPool:{transaction:fn=>sql.transaction(c=>fn(c as unknown as SqlClient))},applicationRoleArns:identity,
    cutoverRoleArns:identity,readerRoleArns:identity,operationalVerifierRoleArns:identity,storeReaderRoleArns:identity});
},30_000);
afterAll(()=>sql.close());afterEach(()=>sql.query('RESET ROLE'));
it('validates every control CHECK before recording completion and rejects invalid actual SQL rows',async()=>{
  const constraints=await sql.query<{conname:string;convalidated:boolean}>("SELECT conname,convalidated FROM pg_constraint WHERE conname=ANY($1::text[])",[NATIVE_CONTROL_CONSTRAINTS.map(c=>c[1])]);
  expect(constraints.rows).toHaveLength(5);expect(constraints.rows.every(c=>c.convalidated)).toBe(true);
  expect((await sql.query('SELECT version FROM olbia.schema_migrations WHERE version=20')).rows).toHaveLength(1);
  for(const s of ["UPDATE olbia.runtime_state SET id='other'","UPDATE olbia.runtime_state SET mode='invalid'","INSERT INTO olbia.runtime_state VALUES ('other','sql',CURRENT_TIMESTAMP)",
    "UPDATE olbia.application_barrier SET id='other'","UPDATE olbia.application_barrier SET generation=-1","INSERT INTO olbia.application_barrier VALUES ('other',0)",
    'INSERT INTO olbia.schema_migrations VALUES (0,CURRENT_TIMESTAMP)','INSERT INTO olbia.schema_migrations VALUES (-1,CURRENT_TIMESTAMP)'])await expect(sql.query(s)).rejects.toMatchObject({code:'23514'});
});
it('keeps the native OCC increment available to all actual writers and denies every identity rewrite',async()=>{
  const before=(await sql.query('SELECT * FROM olbia.application_barrier')).rows,rollback=new Error('Expected rollback');
  for(const role of roles){
    await sql.query(`SET ROLE ${role}`);
    await expect(sql.query("UPDATE olbia.application_barrier SET id=id WHERE id='storage'")).rejects.toMatchObject({code:'42501'});
    await expect(sql.query('DELETE FROM olbia.application_barrier')).rejects.toMatchObject({code:'42501'});
    await expect(sql.query("INSERT INTO olbia.application_barrier VALUES ('storage',0)")).rejects.toMatchObject({code:'42501'});
    if(['olbia_application','olbia_cutover','olbia_projector'].includes(role)){
      await expect(sql.transaction(async c=>{await c.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");throw rollback;})).rejects.toBe(rollback);
    }else await expect(sql.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'")).rejects.toMatchObject({code:'42501'});
    await sql.query('RESET ROLE');expect((await sql.query('SELECT * FROM olbia.application_barrier')).rows).toEqual(before);
  }
});
it('allows only the existing operator to change authority mode/time while keeping storage identity immutable',async()=>{
  const before=(await sql.query('SELECT * FROM olbia.runtime_state')).rows,rollback=new Error('Expected rollback');
  for(const role of roles){
    await sql.query(`SET ROLE ${role}`);await expect(sql.query('UPDATE olbia.runtime_state SET id=id')).rejects.toMatchObject({code:'42501'});
    if(role==='olbia_cutover')await expect(sql.transaction(async c=>{
      for(const mode of ['sql','paused','dynamodb'])await c.query("UPDATE olbia.runtime_state SET mode=$1,changed_at=CURRENT_TIMESTAMP WHERE id='storage'",[mode]);
      await expect(c.query("UPDATE olbia.runtime_state SET mode='invalid'")).rejects.toMatchObject({code:'23514'});throw rollback;
    })).rejects.toBe(rollback);
    else await expect(sql.query("UPDATE olbia.runtime_state SET mode='paused',changed_at=CURRENT_TIMESTAMP WHERE id='storage'")).rejects.toMatchObject({code:'42501'});
    await expect(sql.query('INSERT INTO olbia.schema_migrations VALUES (999,CURRENT_TIMESTAMP)')).rejects.toMatchObject({code:'42501'});
    await sql.query('RESET ROLE');expect((await sql.query('SELECT * FROM olbia.runtime_state')).rows).toEqual(before);
  }
});
it('stops bootstrap before financial copy/grants/completion if a native control validation fails',async()=>{
  const query=vi.fn(async(s:string,v?:unknown[])=>({rows:s.includes('pg_constraint')?[{convalidated:v?.[1]!=='runtime_state_mode'}]:s.startsWith('ALTER TABLE ASYNC')?[{job_id:'failed-control-job'}]:s.includes('sys.jobs')?[{status:'failed'}]:[]}));
  await expect(bootstrapSchema({query},[],{transactionPool:{transaction:vi.fn()}})).rejects.toThrow('native-control-runtime_state_mode-validation');
  expect(query.mock.calls.map(([s])=>s).join()).not.toMatch(/AWS IAM GRANT|VALUES \(20,|SELECT version FROM olbia.schema_migrations WHERE version=9/);
});
it('resumes native validated controls without duplicate DDL or a premature migration marker',async()=>{
  const query=vi.fn(async(_s:string,_v?:unknown[])=>({rows:[{convalidated:true}]}));await ensureNativeControlConstraints({query});
  expect(query).toHaveBeenCalledTimes(5);expect(query.mock.calls.every(call=>String(call[0]).startsWith('SELECT convalidated'))).toBe(true);
});
