import { withStoreClient } from '@finance/ledger/dsql-store';
import { afterEach, expect, it, vi } from 'vitest';
import * as readers from '../src/events/sql-reads.js';
import { readOperationalItem, readOperationalPartition, sqlOperationalPartition, selectOperationalRecords } from '../src/operational/reads.js';

afterEach(() => {vi.restoreAllMocks();vi.unstubAllEnvs();});

it('blocks SQL and configured subscription reads before every source/fallback mode after activation', async () => {
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');
  const query=vi.fn(async(_statement:string)=>({rows:[{version:16}]}));vi.spyOn(readers,'readerPool').mockReturnValue({query});
  const send=vi.fn(),source=vi.fn(),sql=vi.fn();const store={database:{send} as never,tableName:'metadata'};
  for(const mode of ['dynamodb','shadow','guarded-sql']) {
    vi.stubEnv('DSQL_OPERATIONAL_READ_MODE',mode);
    for(const action of [
      ()=>readOperationalPartition('push_subscriptions',store,'USER#owner','PUSH#'),
      ()=>readOperationalItem('push_subscriptions',store,'USER#owner','PUSH#test'),
      ()=>sqlOperationalPartition('push_subscriptions','USER#owner','PUSH#',{query}),
      ()=>selectOperationalRecords('push_subscriptions',source,sql),
    ]) await expect(action()).rejects.toMatchObject({name:'MigrationPausedException'});
  }
  expect(send).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();expect(sql).not.toHaveBeenCalled();
  expect(query.mock.calls.every(([statement])=>statement==='SELECT version FROM olbia.schema_migrations WHERE version=16')).toBe(true);
});

it('keeps ordinary subscription metadata reads and other operational families available before activation',async()=>{
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','true');vi.stubEnv('DSQL_OPERATIONAL_READ_MODE','dynamodb');
  const item={PK:'USER#owner',SK:'PUSH#test',active:true,contentMode:'private'};
  const query=vi.fn(async(statement:string)=>({rows:statement.includes('source_item')?[{source_item:item}]:[]}));vi.spyOn(readers,'readerPool').mockReturnValue({query});
  const send=vi.fn(async()=>({Items:[item],Item:item})),store={database:{send} as never,tableName:'metadata'};
  await withStoreClient({query},async()=>{
    expect(await readOperationalPartition('push_subscriptions',store,item.PK,'PUSH#')).toEqual([item]);
    expect(await readOperationalItem('push_subscriptions',store,item.PK,item.SK)).toEqual(item);
  });
  expect(send).not.toHaveBeenCalled();
  vi.stubEnv('OLBIA_SQL_STORE_ENABLED','false');
  expect(await readOperationalPartition('push_subscriptions',store,item.PK,'PUSH#')).toEqual([item]);
  query.mockClear();await readOperationalPartition('assistant_threads',store,item.PK,'ASSISTANT_THREAD#');expect(query).not.toHaveBeenCalled();
});
