import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { database, tableName } from '../http/clients.js';
import {
  deleteAssistantThread,
  getAssistantThread,
  listAssistantThreads,
  saveAssistantThread,
  setActiveAssistantThread,
} from './threads.js';

const memoryId = process.env.AGENT_MEMORY_ID?.trim();
const memory = new BedrockAgentCoreClient({
  region: process.env.AGENTCORE_REGION?.trim() || undefined,
});

const historyDependencies = () => {
  if (!memoryId) throw new Error('Agent memory is not configured.');
  return { database, tableName, memory, memoryId };
};

const storeDependencies = { database, tableName };

export const prepareAssistantThread = (
  owner: string,
  sessionId: string,
  message: string,
  month: string,
) => saveAssistantThread(storeDependencies, { owner, sessionId, message, month });

export const listOwnerAssistantThreads = (owner: string) =>
  listAssistantThreads(historyDependencies(), owner);

export const getOwnerAssistantThread = (owner: string, sessionId: string) =>
  getAssistantThread(historyDependencies(), owner, sessionId);

export const activateOwnerAssistantThread = (owner: string, sessionId: string | undefined) =>
  setActiveAssistantThread(storeDependencies, owner, sessionId);

export const deleteOwnerAssistantThread = (owner: string, sessionId: string) =>
  deleteAssistantThread(historyDependencies(), owner, sessionId);
