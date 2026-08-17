import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/agent/tool-definitions.js';

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
});
