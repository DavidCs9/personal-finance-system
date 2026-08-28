import {
  applyAgentCategoryEdits,
  applyAgentCategoryEdit,
  applyAgentTagEdit,
  parseAgentCategoryEditInput,
  parseBulkEditInput,
  previewAgentCategoryEdit,
  previewBulkEdit,
  undoAgentCategoryEdit,
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

const operationIdsFrom = (input: Record<string, unknown>): readonly string[] => {
  if (!Array.isArray(input.operationIds)) throw new Error('operationIds es obligatorio.');
  return input.operationIds.map((operationId) => typeof operationId === 'string' ? operationId : '');
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
    case 'preview_category_edit':
      return previewAgentCategoryEdit(owner, parseAgentCategoryEditInput(input));
    case 'apply_category_edit':
      return applyAgentCategoryEdit(owner, operationIdFrom(input));
    case 'undo_category_edit':
      return undoAgentCategoryEdit(owner, operationIdFrom(input));
    case 'apply_category_edits':
      return applyAgentCategoryEdits(owner, operationIdsFrom(input));
    default:
      throw new Error(`Tool de mutación desconocida: ${name}`);
  }
};
