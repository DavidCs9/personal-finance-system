import {
  applyAgentTagEdit,
  parseBulkEditInput,
  previewBulkEdit,
  undoAgentTagEdit,
} from '../events/bulk-edits.js';
import {
  TAG_MUTATION_TOOL_DEFINITIONS,
  type TagMutationToolName,
} from './tag-mutation-tool-definitions.js';

export { TAG_MUTATION_TOOL_DEFINITIONS, type TagMutationToolName };

const operationIdFrom = (input: Record<string, unknown>): string => {
  const operationId = typeof input.operationId === 'string' ? input.operationId.trim() : '';
  if (!operationId) throw new Error('operationId es obligatorio.');
  return operationId;
};

export const runTagMutationTool = async (
  owner: string,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> => {
  switch (name as TagMutationToolName | string) {
    case 'preview_tag_edit':
      return previewBulkEdit(owner, parseBulkEditInput({
        selection: {
          fromDay: input.fromDay,
          toDay: input.toDay,
          statuses: ['accepted'],
        },
        change: {
          ...(Array.isArray(input.addTags) ? { addTags: input.addTags } : {}),
          ...(Array.isArray(input.removeTags) ? { removeTags: input.removeTags } : {}),
        },
      }));
    case 'apply_tag_edit':
      return applyAgentTagEdit(owner, operationIdFrom(input));
    case 'undo_tag_edit':
      return undoAgentTagEdit(owner, operationIdFrom(input));
    default:
      throw new Error(`Tool de mutación desconocida: ${name}`);
  }
};
