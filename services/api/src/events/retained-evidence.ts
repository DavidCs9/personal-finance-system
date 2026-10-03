import type { ReadSqlClient } from './sql-reads.js';
import type { JsonObject } from '../http/response.js';

/** Frozen migration evidence only. Product decisions read native domain relations. */
export async function* readRetainedEvidencePages(client:ReadSqlClient,planningOwner?:string,pageSize=100):AsyncGenerator<readonly JsonObject[]> {
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100||planningOwner!==undefined&&!planningOwner.length)throw new Error('Invalid retained evidence scope');
  let pk='',sk='';
  for(;;){
    const values:unknown[]=[pk,sk,pageSize];
    const scope=planningOwner===undefined?'':" AND source_pk=$4 AND (left(source_sk,6)='MONTH#' OR left(source_sk,8)='PAYROLL#')";
    if(planningOwner!==undefined)values.push(`USER#${planningOwner}`);
    const page=(await client.query(`SELECT source_pk,source_sk,source_item FROM olbia.projection_state WHERE deleted=false
      AND (source_pk,source_sk)>($1,$2)${scope} ORDER BY source_pk,source_sk LIMIT $3`,values)).rows;
    const evidence=page.map(row=>{
      const item=row.source_item as JsonObject|undefined;
      if(!item||item.PK!==row.source_pk||item.SK!==row.source_sk)throw new Error('Frozen evidence identity is inconsistent');return item;
    });
    yield evidence;if(page.length<pageSize)return;
    const last=page.at(-1)!;pk=String(last.source_pk);sk=String(last.source_sk);
  }
}
