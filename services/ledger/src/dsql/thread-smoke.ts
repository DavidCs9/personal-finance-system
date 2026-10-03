import { randomUUID } from 'node:crypto';
import type { SqlClient } from './projection.js';
import { upsertConversation, selectConversation, readConversationMetadata, readConversationSelection, deleteConversationMetadata } from './thread.js';
/** Caller completely rolls back metadata and the original choice. Never creates provider sessions/events. */
export const smokeNativeThreads=async(client:SqlClient,owner:string):Promise<void>=>{
  if(!(await client.query('SELECT version FROM olbia.schema_migrations WHERE version=18')).rows.length)throw new Error('Native conversations are not active');
  const id=`sql_verification_${randomUUID()}`,at=new Date().toISOString();
  const thread=await upsertConversation(client,{owner,id,title:'SQL rollback verification',month:at.slice(0,7),at});
  await selectConversation(client,owner,id,at);
  if(thread.id!==id||(await readConversationSelection(client,owner)).id!==id)throw new Error('Native conversation selection failed');
  await upsertConversation(client,{owner,id,title:'Must not replace original',month:'9999-12',at});
  if((await readConversationMetadata(client,owner,id))?.title!=='SQL rollback verification')throw new Error('Original conversation metadata changed');
  await deleteConversationMetadata(client,owner,id,at);
  if(await readConversationMetadata(client,owner,id)||(await readConversationSelection(client,owner)).id!==undefined)throw new Error('Native conversation deletion failed');
};
