import { PGlite } from '@electric-sql/pglite';
import { beforeAll,beforeEach,afterAll,expect,it,vi } from 'vitest';
import { readRetainedEvidencePages } from '../src/events/retained-evidence.js';
let sql:PGlite;
beforeAll(async()=>{sql=new PGlite();await sql.exec('CREATE SCHEMA olbia;CREATE TABLE olbia.projection_state(source_pk text,source_sk text,deleted boolean NOT NULL,source_item jsonb,PRIMARY KEY(source_pk,source_sk))');},30_000);
afterAll(()=>sql.close());beforeEach(()=>sql.exec('TRUNCATE olbia.projection_state'));
const insert=async(pk:string,sk:string,deleted=false)=>sql.query('INSERT INTO olbia.projection_state VALUES ($1,$2,$3,$4)',[pk,sk,deleted,deleted?null:JSON.stringify({PK:pk,SK:sk,original:{optional:0}})]);
const pages=async(owner?:string,size?:number)=>{const result=[];for await(const page of readRetainedEvidencePages(sql,owner,size))result.push(page);return result;};
it('pages 205 actual frozen records with native cursor limits and no repeated transfer or tombstones',async()=>{
 for(let n=0;n<205;n++)await insert('USER#owner',`ROW#${String(n).padStart(3,'0')}`);await insert('USER#owner','ROW#expired',true);
 const query=vi.spyOn(sql,'query');try{const result=await pages();expect(result.map(p=>p.length)).toEqual([100,100,5]);expect(result.flat()).toHaveLength(205);
  expect(new Set(result.flat().map(r=>r.SK)).size).toBe(205);expect(query.mock.calls.map(([,values])=>values)).toEqual([['','',100],['USER#owner','ROW#099',100],['USER#owner','ROW#199',100]]);
  expect(result[0][0].original).toEqual({optional:0});}finally{query.mockRestore();}
});
it('preserves exact owner/prefix boundaries, source ordering and both kinds of planning original',async()=>{
 for(const [pk,sk]of [['USER#owner%_','MONTH#2026-10'],['USER#owner%_','PAYROLL#2026-10#receipt'],['USER#owner%_','MONTHLY_CLOSE#2026-10'],['USER#owner%_','PAYROLLX#2026-10'],['USER#other','MONTH#2026-10']])await insert(pk,sk);
 expect((await pages('owner%_',1)).flat().map(r=>r.SK)).toEqual(['MONTH#2026-10','PAYROLL#2026-10#receipt']);
 expect(await pages('missing-owner')).toEqual([[]]);
});
it('returns an empty bounded page and rejects invalid page sizes before SQL',async()=>{
 expect(await pages()).toEqual([[]]);const query=vi.spyOn(sql,'query');try{for(const n of [0,101,1.5])await expect(pages(undefined,n)).rejects.toThrow('Invalid retained evidence scope');expect(query).not.toHaveBeenCalled();}finally{query.mockRestore();}
});
it('rejects a corrupted original identity independently of projection classification',async()=>{
 await insert('USER#owner','MONTH#2026-10');await sql.query(`UPDATE olbia.projection_state SET source_item=jsonb_set(source_item,'{PK}','"corrupt"')`);
 await expect(pages()).rejects.toThrow('Frozen evidence identity is inconsistent');
});
