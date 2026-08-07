import {
  CAJITA_ACCOUNT_ID,
  WEALTH_ACCOUNTS,
  type WealthAccountId,
  type WealthSnapshot,
} from '@finance/domain';

export const wealthSnapshotKey = (
  owner: string,
  accountId: WealthAccountId,
  day: string,
): { readonly PK: string; readonly SK: string } => ({
  PK: `USER#${owner}`,
  SK: `WEALTH_SNAP#${accountId}#${day}`,
});

export const wealthSnapshotVersionKey = (
  owner: string,
  accountId: WealthAccountId,
  day: string,
  capturedAt: string,
): { readonly PK: string; readonly SK: string } => ({
  PK: `USER#${owner}`,
  SK: `WEALTH_VER#${accountId}#${day}#${capturedAt}`,
});

export const wealthSnapshotSkPrefix = 'WEALTH_SNAP#';

export const liabilitySnapshotKey = (
  owner: string,
  cardId: string,
  day: string,
): { readonly PK: string; readonly SK: string } => ({
  PK: `USER#${owner}`,
  SK: `LIAB_SNAP#${cardId}#${day}`,
});

export const liabilitySnapshotVersionKey = (
  owner: string,
  cardId: string,
  day: string,
  capturedAt: string,
): { readonly PK: string; readonly SK: string } => ({
  PK: `USER#${owner}`,
  SK: `LIAB_VER#${cardId}#${day}#${capturedAt}`,
});

export const liabilitySnapshotSkPrefix = 'LIAB_SNAP#';

export const seededWealthAccounts = () => WEALTH_ACCOUNTS;

export const isCajitaAccount = (accountId: string): accountId is typeof CAJITA_ACCOUNT_ID =>
  accountId === CAJITA_ACCOUNT_ID;

export type StoredWealthSnapshot = WealthSnapshot & {
  readonly owner: string;
  readonly entityType: 'wealth_snapshot';
  readonly supersededAt?: string;
};
