import { describe, expect, it } from 'vitest';
import { isAuthorized } from '@cedar-policy/cedar-wasm/nodejs';
import { mcpToolPolicy } from '../lib/mcp-tool-policy.js';
import { FINANCIAL_WRITE_TOOL_DEFINITIONS } from '@finance/api/agent-financial-tool-definitions';
import { TAG_MUTATION_TOOL_DEFINITIONS } from '@finance/api/agent-tag-mutation-tool-definitions';
const owner = '11111111-2222-4333-8444-555555555555';
const arn = 'arn:aws:bedrock-agentcore:us-east-2:123456789012:gateway/olbiachatgptread-example';
const base = 'https://olbiachatgptread-example.gateway.bedrock-agentcore.us-east-2.amazonaws.com/mcp';
const writeGroups = [
  { target: 'olbia-financial-writes', tools: FINANCIAL_WRITE_TOOL_DEFINITIONS },
  { target: 'olbia-classification-writes', tools: TAG_MUTATION_TOOL_DEFINITIONS },
];
const policies = writeGroups.map(group => mcpToolPolicy({ owner, gatewayArn: arn, targetName: group.target, toolNames: group.tools.map(tool => tool.name), scope: `${base}/write` })).join('\n');
const authorize = (action: string, scope?: string, subject = owner, tokenUse = 'access', resource = arn) => {
  const answer = isAuthorized({ principal: { type: 'AgentCore::OAuthUser', id: subject }, action: { type: 'AgentCore::Action', id: action },
    resource: { type: 'AgentCore::Gateway', id: resource }, context: {}, policies: { staticPolicies: policies },
    entities: [{ uid: { type: 'AgentCore::OAuthUser', id: subject }, attrs: {}, parents: [], tags: { token_use: tokenUse, ...(scope === undefined ? {} : { scope }) } }] });
  expect(answer.type).toBe('success');
  return answer.type === 'success' ? answer.response.decision : 'deny';
};
describe('native Cedar scope enforcement for the single MCP connection', () => {
  for (const group of writeGroups) for (const tool of group.tools) {
    it(`${group.target}/${tool.name} denies a read-only token and permits the exact write scope`, () => {
      const action = `${group.target}___${tool.name}`;
      expect(authorize(action, `${base}/read`)).toBe('deny');
      for (const scopes of [`${base}/write`, `${base}/write ${base}/read`, `${base}/read ${base}/write`, `openid ${base}/write profile`])
        expect(authorize(action, scopes)).toBe('allow');
      for (const scopes of [undefined, '', `${base}/write:admin`, `prefix${base}/write`, `${base}/write-suffix`, `${base}/read ${base}/write:admin`, `openid ${base}/write:admin profile`])
        expect(authorize(action, scopes)).toBe('deny');
      expect(authorize(action, `${base}/write`, 'different-owner')).toBe('deny');
      expect(authorize(action, `${base}/write`, owner, 'id')).toBe('deny');
      expect(authorize(action, `${base}/write`, owner, 'access', `${arn}-different`)).toBe('deny');
    });
  }
  it('defaults to deny for every unregistered tool', () => {
    expect(authorize('olbia-financial-writes___arbitrary_sql', `${base}/write`)).toBe('deny');
    expect(authorize('untrusted-target___apply_income_change', `${base}/write`)).toBe('deny');
  });
});
