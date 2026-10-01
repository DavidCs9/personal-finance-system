import { FONDO_AHORRO_ACCOUNT_ID, isWealthAccountId, type WealthSnapshot, type CardLiabilitySnapshot } from '@finance/domain';
import { isValidCardId } from '../cards/cards.js';

export const toPublicSnapshot = (item: Record<string, unknown>): WealthSnapshot | undefined => {
  const accountId = item.accountId;
  if (typeof accountId !== 'string' || !isWealthAccountId(accountId)) return undefined;
  if (accountId === FONDO_AHORRO_ACCOUNT_ID) return undefined;
  if (typeof item.day !== 'string' || typeof item.capturedAt !== 'string') return undefined;
  if (typeof item.totalMxnMinor !== 'number' || !Array.isArray(item.holdings)) return undefined;
  const source = item.source;
  if (source !== 'manual' && source !== 'api' && source !== 'flex') return undefined;
  return {
    accountId,
    day: item.day,
    capturedAt: item.capturedAt,
    source,
    currency: 'MXN',
    totalMxnMinor: item.totalMxnMinor,
    holdings: item.holdings as WealthSnapshot['holdings'],
    ...(item.evidence && typeof item.evidence === 'object'
      ? { evidence: item.evidence as WealthSnapshot['evidence'] }
      : {}),
    ...(typeof item.fxRate === 'number' ? { fxRate: item.fxRate } : {}),
    ...(typeof item.fxSource === 'string' ? { fxSource: item.fxSource } : {}),
  };
};

export const toPublicLiabilitySnapshot = (item: Record<string, unknown>): CardLiabilitySnapshot | undefined => {
  if (typeof item.cardId !== 'string' || !isValidCardId(item.cardId)) return undefined;
  if (typeof item.day !== 'string' || typeof item.capturedAt !== 'string') return undefined;
  if (typeof item.totalMxnMinor !== 'number' || !Number.isInteger(item.totalMxnMinor) || item.totalMxnMinor < 0) {
    return undefined;
  }
  if (item.source !== 'manual') return undefined;
  return {
    cardId: item.cardId,
    day: item.day,
    capturedAt: item.capturedAt,
    source: 'manual',
    currency: 'MXN',
    totalMxnMinor: item.totalMxnMinor,
    ...(item.evidence && typeof item.evidence === 'object'
      ? { evidence: item.evidence as CardLiabilitySnapshot['evidence'] }
      : {}),
  };
};

