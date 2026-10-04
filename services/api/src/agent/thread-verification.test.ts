import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../../ledger/test/helpers/migration-schema.js';
import { upsertConversation, selectConversation } from '@finance/ledger/native-threads';
import { verifyNativeConversationMetadata } from './thread-verification.js';
let sql:PGlite;
const id='11111111-1111-1111-1111-111111111111',now=new Date('2026-10-03T12:00:00Z');
beforeAll(async()=>{sql=new PGlite();for(const s of SCHEMA_STATEMENTS)await sql.query(s);await sql.query('INSERT INTO olbia.schema_migrations VALUES (18,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING');},30_000);
afterAll(()=>sql.close());beforeEach(()=>sql.exec('TRUNCATE olbia.assistant_thread_selection,olbia.conversation_threads'));
it('compares actual native adapters and exact expiry/ownership boundaries without provider IO or writes',async()=>{
  await upsertConversation(sql,{id,owner:'owner',title:'Preserved',month:'2026-09',at:'2026-09-01T12:00:00.123Z'});await selectConversation(sql,'owner',id,now.toISOString());
  const before=(await sql.query('SELECT * FROM olbia.conversation_threads')).rows;
  const gate=await verifyNativeConversationMetadata('owner',now,sql as never);
  expect(gate).toMatchObject({activated:true,headers:1,selectionRows:1,validatedConstraints:10,requiredColumns:10,mismatches:0});
  expect(gate.expiryChecks).toBeGreaterThan(3);expect(gate.productReads).toBeGreaterThan(8);
  expect((await sql.query('SELECT * FROM olbia.conversation_threads')).rows).toEqual(before);
});
it('verifies configured-null and absent selections without inventing a latest active header',async()=>{
  expect((await verifyNativeConversationMetadata('owner',now,sql as never)).mismatches).toBe(0);
  await selectConversation(sql,'owner',undefined,now.toISOString());expect((await verifyNativeConversationMetadata('owner',now,sql as never)).mismatches).toBe(0);
});
it('detects missing owner constraints and the real selection FK rather than accepting matching presentation',async()=>{
  await sql.query('ALTER TABLE olbia.assistant_thread_selection DROP CONSTRAINT assistant_thread_selection_owner_fk');
  try{expect((await verifyNativeConversationMetadata('owner',now,sql as never)).mismatches).toBeGreaterThan(0);}
  finally{await sql.query('ALTER TABLE olbia.assistant_thread_selection ADD CONSTRAINT assistant_thread_selection_owner_fk FOREIGN KEY (thread_id,owner) REFERENCES olbia.conversation_threads(id,owner)');}
});
