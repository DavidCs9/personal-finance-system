import type { Institution } from '@finance/domain';
import type { BedrockEmailExtraction } from './bedrock-extractor.js';

export interface EmailSourceJob {
  readonly receivedAt: string;
  readonly sourceMessageId?: string;
  readonly source: { readonly bucket: string; readonly key: string };
  readonly retryExceptionId?: string;
}

export interface BedrockFallbackJob extends EmailSourceJob {
  readonly institutionHint: Institution;
  readonly primaryFailure: string;
}

export interface IngestionJob extends EmailSourceJob {
  readonly bedrockExtraction?: {
    readonly version: string;
    readonly institutionHint: Institution;
    readonly primaryFailure: string;
    readonly result: BedrockEmailExtraction;
  };
}
