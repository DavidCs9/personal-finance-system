import type { Context } from 'aws-lambda';
import { runTagMutationTool, TAG_MUTATION_TOOL_DEFINITIONS } from './tag-mutation-tools.js';

export const handler = async (
  event: Record<string, unknown>,
  context: Context,
): Promise<unknown> => {
  const owner = process.env.AGENT_OWNER?.trim();
  if (!owner) throw new Error('AGENT_OWNER is not configured on the tag mutation Lambda.');
  return runTagMutationTool(owner, resolveToolName(event, context), resolveArgs(event));
};

export const tagMutationGatewayToolDefinitions = () =>
  TAG_MUTATION_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

const resolveToolName = (event: Record<string, unknown>, context: Context): string => {
  const custom = (context.clientContext as { custom?: Record<string, string> } | null)?.custom;
  const fromContext = custom?.bedrockAgentCoreToolName;
  if (typeof fromContext === 'string' && fromContext.length > 0) {
    return fromContext.includes('___') ? fromContext.split('___').slice(1).join('___') : fromContext;
  }
  if (typeof event.name === 'string') return event.name;
  if (typeof event.toolName === 'string') return event.toolName;
  throw new Error('Missing Gateway tool name.');
};

const resolveArgs = (event: Record<string, unknown>): Record<string, unknown> => {
  if (event.arguments && typeof event.arguments === 'object' && !Array.isArray(event.arguments)) {
    return event.arguments as Record<string, unknown>;
  }
  const { name: _name, toolName: _toolName, ...rest } = event;
  return rest;
};
