import { describe, expect, it } from 'vitest';
import { cloudFormationTagMutationTools } from '../lib/personal-finance-v1-stack.js';

describe('AgentCore tag mutation target schema', () => {
  it('uses CloudFormation property casing while preserving the MCP contract', () => {
    expect(cloudFormationTagMutationTools.map(({ Name }) => Name)).toEqual([
      'preview_tag_edit',
      'apply_tag_edit',
      'undo_tag_edit',
      'preview_category_edit',
      'apply_category_edit',
      'undo_category_edit',
      'apply_category_edits',
    ]);
    expect(cloudFormationTagMutationTools[0]).toMatchObject({
      Name: 'preview_tag_edit',
      InputSchema: {
        Type: 'object',
        Required: ['fromDay', 'toDay'],
        Properties: {
          fromDay: { Type: 'string' },
          addTags: { Type: 'array', Items: { Type: 'string' } },
        },
      },
    });
    expect(cloudFormationTagMutationTools[0]).not.toHaveProperty('name');
    expect(cloudFormationTagMutationTools[0]).not.toHaveProperty('inputSchema');
    expect(cloudFormationTagMutationTools[3]).toMatchObject({
      Name: 'preview_category_edit',
      InputSchema: {
        Required: ['categoryId'],
        Properties: {
          categoryId: { Type: 'string' },
          eventIds: { Type: 'array', Items: { Type: 'string' } },
          onlyUncategorized: { Type: 'boolean' },
        },
      },
    });
  });
});
