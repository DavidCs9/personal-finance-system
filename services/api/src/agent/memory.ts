import {
  BedrockAgentCoreClient,
  DeleteMemoryRecordCommand,
  ListMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const memoryId = process.env.AGENT_MEMORY_ID?.trim();
const agentcore = new BedrockAgentCoreClient({
  region: process.env.AGENTCORE_REGION?.trim() || undefined,
});

export type AssistantMemory = {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
};

const namespacesFor = (owner: string) => [
  `/users/${owner}/facts/`,
  `/users/${owner}/preferences/`,
  `/users/${owner}/summaries/`,
] as const;

const requireMemoryId = (): string => {
  if (!memoryId) throw new Error('Agent memory is not configured.');
  return memoryId;
};

export const listAssistantMemories = async (owner: string): Promise<readonly AssistantMemory[]> => {
  const id = requireMemoryId();
  const pages = await Promise.all(namespacesFor(owner).map(async (namespace) => {
    const response = await agentcore.send(new ListMemoryRecordsCommand({
      memoryId: id,
      namespace,
      maxResults: 50,
    }));
    return response.memoryRecordSummaries ?? [];
  }));
  return pages.flat().flatMap((record) => {
    const text = 'text' in (record.content ?? {}) ? record.content?.text : undefined;
    if (!record.memoryRecordId || !text || !record.createdAt) return [];
    return [{ id: record.memoryRecordId, text, createdAt: record.createdAt.toISOString() }];
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

export const deleteAssistantMemory = async (owner: string, memoryRecordId: string): Promise<void> => {
  const memories = await listAssistantMemories(owner);
  if (!memories.some((memory) => memory.id === memoryRecordId)) {
    throw new Error('Memory record was not found for this user.');
  }
  await agentcore.send(new DeleteMemoryRecordCommand({
    memoryId: requireMemoryId(),
    memoryRecordId,
  }));
};
