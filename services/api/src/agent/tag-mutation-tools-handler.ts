import type { Context } from 'aws-lambda';
import { runTagMutationTool, TAG_MUTATION_TOOL_DEFINITIONS } from './tag-mutation-tools.js';
import { InvalidBulkEditError } from '../events/bulk-edits.js';
import { InvalidCategoryError } from '../categories/catalog.js';
import { rejectedToolRequest } from './tool-errors.js';

export const handler = async (
  event: Record<string, unknown>,
  context: Context,
): Promise<unknown> => {
  const owner = process.env.AGENT_OWNER?.trim();
  if (!owner) throw new Error('AGENT_OWNER is not configured on the tag mutation Lambda.');
  const toolName = resolveToolName(event, context);
  try {
    return await runTagMutationTool(owner, toolName, resolveArgs(event, context));
  } catch (error) {
    if (error instanceof InvalidCategoryError || error instanceof InvalidBulkEditError) {
      return rejectedToolRequest(error.message,
        error instanceof InvalidCategoryError ? 'list_categories'
          : error.recoveryTool === 'list_movements' && /^(apply|undo)_/.test(toolName)
            ? 'edit_operation_status' : error.recoveryTool);
    }
    throw error;
  }
};

export const tagMutationGatewayToolDefinitions = () =>
  TAG_MUTATION_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

const gatewayToolName = (context: Context): string | undefined => {
  const custom = (context.clientContext as { custom?: Record<string, string> } | null)?.custom;
  const fromContext = custom?.bedrockAgentCoreToolName;
  if (typeof fromContext === 'string' && fromContext.length > 0) {
    return fromContext.includes('___') ? fromContext.split('___').slice(1).join('___') : fromContext;
  }
  return undefined;
};

const resolveToolName = (event: Record<string, unknown>, context: Context): string => {
  const fromGateway = gatewayToolName(context);
  if (fromGateway) return fromGateway;
  if (typeof event.toolName === 'string') return event.toolName;
  if (typeof event.name === 'string') return event.name;
  throw new Error('Missing Gateway tool name.');
};

const resolveArgs = (event: Record<string, unknown>, context: Context): Record<string, unknown> => {
  if (event.arguments && typeof event.arguments === 'object' && !Array.isArray(event.arguments)) {
    return event.arguments as Record<string, unknown>;
  }
  // Native Gateway events are the arguments themselves. In particular, `name`
  // is the category label, not a dispatch envelope field.
  if (gatewayToolName(context)) return event;
  if (typeof event.toolName === 'string') {
    const { toolName: _toolName, ...rest } = event;
    return rest;
  }
  const { name: _name, ...rest } = event;
  return rest;
};
