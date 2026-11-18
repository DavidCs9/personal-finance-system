import type { Context } from 'aws-lambda';
import { FinancialPlanError } from '@finance/domain';
import { InvalidManualEntryError } from '../events/manual-entry-input.js';
import { runFinancialWriteTool } from './financial-write-tools.js';
import { rejectedToolRequest } from './tool-errors.js';

/** Only the trusted, scoped-policy Gateway target may invoke this bounded Lambda. JWT claims are never accepted in arguments. */
export const handler = async (event: Record<string, unknown>, context: Context): Promise<unknown> => {
  const owner = process.env.AGENT_OWNER?.trim();
  if (!owner) throw new Error('AGENT_OWNER is not configured on financial write tools.');
  const gatewayName = (context.clientContext as { custom?: Record<string, string> } | null)?.custom?.bedrockAgentCoreToolName;
  const name = gatewayName ? gatewayName.split('___').at(-1)! : typeof event.toolName === 'string' ? event.toolName : String(event.name ?? '');
  const args = event.arguments && typeof event.arguments === 'object' && !Array.isArray(event.arguments)
    ? event.arguments as Record<string, unknown> : gatewayName ? event : Object.fromEntries(Object.entries(event).filter(([key]) => key !== (typeof event.toolName === 'string' ? 'toolName' : 'name')));
  try { return await runFinancialWriteTool(owner, name, args); }
  catch (error) {
    if (error instanceof FinancialPlanError || error instanceof InvalidManualEntryError)
      return { ...rejectedToolRequest(error.message, name.startsWith('apply_') ? 'get_financial_write_status' : name),
        reasonCode: error instanceof FinancialPlanError ? error.reasonCode : 'invalid_request' };
    throw error;
  }
};
