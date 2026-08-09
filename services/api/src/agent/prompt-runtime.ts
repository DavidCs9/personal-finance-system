import {
  BedrockAgentClient,
  GetPromptCommand,
  type GetPromptResponse,
} from '@aws-sdk/client-bedrock-agent';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
const bedrockAgent = new BedrockAgentClient({});

const promptPointerParam = process.env.SYSTEM_PROMPT_VERSION_PARAM?.trim();
const promptCacheTtlMs = Number(process.env.SYSTEM_PROMPT_CACHE_TTL_MS ?? 30_000);

export interface RuntimePrompt {
  readonly versionArn: string;
  readonly text: string;
  readonly modelId: string;
  readonly temperature: number;
  readonly maxTokens: number;
}

type CacheEntry = {
  readonly expiresAt: number;
  readonly prompt: RuntimePrompt;
};

let cache: CacheEntry | undefined;

const pickVariant = (response: GetPromptResponse) => {
  const defaultName = response.defaultVariant;
  return response.variants?.find((item) => item.name === defaultName)
    ?? response.variants?.[0];
};

const extractPromptText = (response: GetPromptResponse): string => {
  const variant = pickVariant(response);
  if (!variant) throw new Error('Active Prompt Management version has no variants.');

  if (variant.templateConfiguration?.text?.text) {
    return variant.templateConfiguration.text.text;
  }
  const systemBlocks = variant.templateConfiguration?.chat?.system ?? [];
  const text = systemBlocks
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n\n');
  if (!text.trim()) {
    throw new Error('Active Prompt Management version resolved to an empty system prompt.');
  }
  return text;
};

const extractInference = (response: GetPromptResponse) => {
  const variant = pickVariant(response);
  const inference = variant?.inferenceConfiguration?.text;
  if (!variant?.modelId) {
    throw new Error('Active Prompt Management version has no modelId.');
  }
  if (typeof inference?.temperature !== 'number') {
    throw new Error('Active Prompt Management version has no temperature.');
  }
  if (typeof inference.maxTokens !== 'number') {
    throw new Error('Active Prompt Management version has no maxTokens.');
  }
  return {
    modelId: variant.modelId,
    temperature: inference.temperature,
    maxTokens: inference.maxTokens,
  };
};

const readActiveVersionArn = async (): Promise<string> => {
  if (!promptPointerParam) {
    throw new Error('SYSTEM_PROMPT_VERSION_PARAM is not configured.');
  }
  const response = await ssm.send(new GetParameterCommand({ Name: promptPointerParam }));
  const value = response.Parameter?.Value?.trim();
  if (!value) {
    throw new Error(`SSM parameter ${promptPointerParam} is empty.`);
  }
  return value;
};

/**
 * Resolve the live system prompt from Bedrock Prompt Management.
 * Active immutable version ARN lives in SSM → promote/rollback without deploy.
 * Short in-memory cache keeps GetPrompt off most requests.
 */
export const resolveRuntimePrompt = async (now = Date.now()): Promise<RuntimePrompt> => {
  if (cache && cache.expiresAt > now) {
    return cache.prompt;
  }

  const versionArn = await readActiveVersionArn();
  const response = await bedrockAgent.send(new GetPromptCommand({
    promptIdentifier: versionArn,
  }));
  const prompt: RuntimePrompt = {
    versionArn,
    text: extractPromptText(response),
    ...extractInference(response),
  };
  cache = {
    prompt,
    expiresAt: now + Math.max(5_000, promptCacheTtlMs),
  };
  return prompt;
};

/** Test helper — clears the Lambda warm-start cache. */
export const clearRuntimePromptCache = (): void => {
  cache = undefined;
};
