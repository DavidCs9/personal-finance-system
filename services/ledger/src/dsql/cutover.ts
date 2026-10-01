import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createPool } from './connection.js';
import { OlbiaSqlStore, authorityFrom, withStoreClient } from './store.js';
import { canonicalJson, type SourceItem } from './model.js';
import { verifyKeyDetails } from './verification.js';

// Internal IAM-only deployed operator. Product identities cannot update authority.
// Activation is allowed only by the approved cutover rollout's environment flag.
export const cutoverHandler=async (event:{action:'status'|'pause'|'activate'|'smoke'}):Promise<Record<string,unknown>> => {
  const pool=createPool('olbia_cutover');
  try {
    if(event.action==='status') return {mode:await authorityFrom(pool)};
    if(event.action==='smoke') {
      const rollback=new Error('Smoke rollback');let verified=false;
      try {await pool.transaction(async client=>{
        await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
        const raw=(await client.query("SELECT source_item FROM olbia.projection_state WHERE source_sk='EVENT' AND deleted=false ORDER BY source_pk LIMIT 1")).rows[0]?.source_item as SourceItem|undefined;
        if(!raw) throw new Error('No retained movement for smoke');
        const key={PK:raw.PK,SK:raw.SK};const store=new OlbiaSqlStore(pool,process.env.METADATA_TABLE_NAME!);
        await withStoreClient(client,async()=>{
          const input={TableName:process.env.METADATA_TABLE_NAME!,Key:key};
          await store.send(new PutCommand({TableName:input.TableName,Item:raw}));
          const payload=raw.payload as Record<string,unknown>;
          await store.send(new UpdateCommand({...input,UpdateExpression:'SET #payload.#merchant = :merchant',ExpressionAttributeNames:{'#payload':'payload','#merchant':'merchantRaw'},ExpressionAttributeValues:{':merchant':String(payload.merchantRaw??'')+' migration verification'}}));
          const result=await store.send(new GetCommand(input));
          if(result.Item?.payload?.merchantRaw===payload.merchantRaw) throw new Error('Smoke update was not visible');
          await store.send(new DeleteCommand(input));
          if((await store.send(new GetCommand(input))).Item) throw new Error('Smoke delete was not visible');
          await store.send(new PutCommand({TableName:input.TableName,Item:raw}));
          try {await store.send(new TransactWriteCommand({TransactItems:[{Put:{TableName:input.TableName,Item:raw,ConditionExpression:'attribute_not_exists(PK)'}}]}));throw new Error('Condition accepted');}
          catch(error) {if((error as Error).name!=='TransactionCanceledException') throw error;}
          if(canonicalJson((await store.send(new GetCommand(input))).Item)!==canonicalJson(raw)) throw new Error('Smoke restoration differed');
          const parity=await verifyKeyDetails({transaction:callback=>callback(client)},async()=>raw,key);
          if(parity.status!=='equal') throw new Error('Smoke derived rows differed');
        });
        verified=true;throw rollback;
      });} catch(error) {if(error!==rollback) throw error;}
      return {verified,rolledBack:true};
    }
    if(!['pause','activate'].includes(event.action)) throw new Error('Unknown operation');
    if(event.action==='activate' && process.env.OLBIA_ALLOW_SQL_ACTIVATION!=='true') throw new Error('SQL activation requires the approved cutover deployment');
    return await pool.transaction(async client=>{
      await client.query("UPDATE olbia.application_barrier SET generation=generation+1 WHERE id='storage'");
      const previous=await authorityFrom(client);
      if(event.action==='pause' && previous==='sql') return {mode:previous}; // subsequent deployments do not pause an established SQL system
      if(event.action==='activate' && !['paused','sql'].includes(previous)) throw new Error('Pause required before activation');
      const mode=event.action==='pause'?'paused':'sql';
      await client.query("UPDATE olbia.runtime_state SET mode=$1,changed_at=CURRENT_TIMESTAMP WHERE id='storage'",[mode]);
      return {mode};
    });
  } catch {throw new Error('DSQL cutover operation failed; authority retained.');}
  finally {await pool.end();}
};
