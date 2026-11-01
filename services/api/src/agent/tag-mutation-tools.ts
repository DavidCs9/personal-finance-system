import {
  applyAgentTagEdits,
  applyAgentCategoryEdits,
  applyAgentCategoryEdit,
  applyAgentTagEdit,
  parseAgentCategoryEditInput,
  parseAgentTagEditInput,
  previewAgentCategoryEdit,
  previewAgentTagEdit,
  undoAgentCategoryEdit,
  undoAgentTagEdit,
  InvalidBulkEditError,
} from '../events/bulk-edits.js';
import {
  TAG_MUTATION_TOOL_DEFINITIONS,
  type TagMutationToolName,
} from './tag-mutation-tool-definitions.js';
import { manageAgentCategory } from '../categories/control-plane.js';
import { resolveMovementReferences } from './movement-references.js';

export { TAG_MUTATION_TOOL_DEFINITIONS, type TagMutationToolName };

const operationIdFrom = (input: Record<string, unknown>): string => {
  const operationId = typeof input.operationId === 'string' ? input.operationId.trim() : '';
  if (!operationId) throw new InvalidBulkEditError('operationId es obligatorio.');
  return operationId;
};

const operationIdsFrom = (input: Record<string, unknown>): readonly string[] => {
  if (!Array.isArray(input.operationIds)) throw new InvalidBulkEditError('operationIds es obligatorio.');
  return input.operationIds.map((operationId) => typeof operationId === 'string' ? operationId : '');
};

export const runTagMutationTool = async (
  owner: string,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> => {
  switch (name as TagMutationToolName | string) {
    case 'manage_category':
      return manageAgentCategory(owner, input);
    case 'preview_tag_edit':
      return previewAgentTagEdit(owner, parseAgentTagEditInput(await resolveMovementReferences(input)));
    case 'apply_tag_edit':
      return applyAgentTagEdit(owner, operationIdFrom(input));
    case 'undo_tag_edit':
      return undoAgentTagEdit(owner, operationIdFrom(input));
    case 'apply_tag_edits':
      return applyAgentTagEdits(owner, operationIdsFrom(input));
    case 'preview_category_edit':
      return previewAgentCategoryEdit(owner, parseAgentCategoryEditInput(await resolveMovementReferences(input)));
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
