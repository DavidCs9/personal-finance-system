import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/agent/tool-definitions.js';
import { TAG_MUTATION_TOOL_DEFINITIONS } from '../src/agent/tag-mutation-tool-definitions.js';

describe('AgentCore finance tool definitions', () => {
  it('exposes list_movements date ranges without requiring a month', () => {
    const tool = TOOL_DEFINITIONS.find((definition) => definition.name === 'list_movements');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).not.toHaveProperty('required');
    expect(tool?.inputSchema.properties.range).toMatchObject({
      type: 'string',
      enum: [
        'today',
        'yesterday',
        'this_week',
        'last_7_days',
        'this_month',
        'this_year',
        'custom',
      ],
    });
    expect(tool?.inputSchema.properties).toHaveProperty('fromDay');
    expect(tool?.inputSchema.properties).toHaveProperty('toDay');
  });

  it('keeps mutation tools out of the finance read gateway', () => {
    expect(TOOL_DEFINITIONS.map(({ name }) => name)).not.toContain('preview_tag_edit');
    expect(TOOL_DEFINITIONS.map(({ name }) => name)).not.toContain('apply_tag_edit');
    expect(TOOL_DEFINITIONS.map(({ name }) => name)).not.toContain('undo_tag_edit');
    expect(TOOL_DEFINITIONS.map(({ name }) => name)).not.toContain('preview_category_edit');
    expect(TOOL_DEFINITIONS.map(({ name }) => name)).not.toContain('apply_category_edit');
    expect(TOOL_DEFINITIONS.map(({ name }) => name)).not.toContain('undo_category_edit');
    expect(TOOL_DEFINITIONS.map(({ name }) => name)).not.toContain('apply_category_edits');
  });

  it('exposes precise tag and category selectors with batch apply on the mutation gateway', () => {
    expect(TAG_MUTATION_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      'preview_tag_edit',
      'apply_tag_edit',
      'undo_tag_edit',
      'apply_tag_edits',
      'preview_category_edit',
      'apply_category_edit',
      'undo_category_edit',
      'apply_category_edits',
    ]);
    const preview = TAG_MUTATION_TOOL_DEFINITIONS[0];
    expect(preview.inputSchema.properties).toHaveProperty('addTags');
    expect(preview.inputSchema.properties).toHaveProperty('removeTags');
    expect(preview.inputSchema.properties).toHaveProperty('eventIds');
    expect(preview.inputSchema.properties).toHaveProperty('merchantRaw');
    expect(preview.inputSchema.properties).toHaveProperty('sourceTags');
    expect(preview.inputSchema.properties).toHaveProperty('onlyUntagged');
    expect(preview.inputSchema.properties).not.toHaveProperty('categoryId');
    expect(preview.description).toContain('Nunca llames esta tool con sólo fechas');
    const categoryPreview = TAG_MUTATION_TOOL_DEFINITIONS[4];
    expect(categoryPreview.inputSchema.required).toEqual(['categoryId']);
    expect(categoryPreview.inputSchema.properties).toHaveProperty('categoryId');
    expect(categoryPreview.inputSchema.properties).toHaveProperty('eventIds');
    expect(categoryPreview.inputSchema.properties).toHaveProperty('merchantRaw');
    expect(categoryPreview.inputSchema.properties).toHaveProperty('sourceCategoryId');
    expect(categoryPreview.inputSchema.properties).toHaveProperty('onlyUncategorized');
    expect(categoryPreview.inputSchema.properties).not.toHaveProperty('addTags');
    expect(categoryPreview.description).toContain('Nunca llames esta tool con sólo fechas');
  });
});
