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
  });

  it('exposes a tags-only preview/apply/undo contract on the mutation gateway', () => {
    expect(TAG_MUTATION_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      'preview_tag_edit',
      'apply_tag_edit',
      'undo_tag_edit',
    ]);
    const preview = TAG_MUTATION_TOOL_DEFINITIONS[0];
    expect(preview.inputSchema.required).toEqual(['fromDay', 'toDay']);
    expect(preview.inputSchema.properties).toHaveProperty('addTags');
    expect(preview.inputSchema.properties).toHaveProperty('removeTags');
    expect(preview.inputSchema.properties).not.toHaveProperty('categoryId');
    expect(preview.description).toContain('inmediatamente en el mismo turno');
  });
});
