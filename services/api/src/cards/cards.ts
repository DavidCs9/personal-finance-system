import { applicationStoreClient, withApplicationTransaction } from '@finance/ledger/dsql-store';
import { INSTITUTIONS, isInstitution } from '@finance/domain';
import { readSqlCards, toNativeCardRecord } from './sql-reads.js';

export const listCards = readSqlCards;

export const MAX_CARDS = 3;

export interface CardRecord {
  readonly id: string;
  readonly name: string;
  readonly cutOffDay: number;
  readonly paymentDueDay: number;
  readonly institution?: (typeof INSTITUTIONS)[number];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CardInput {
  readonly name: string;
  readonly cutOffDay: number;
  readonly paymentDueDay: number;
  readonly institution?: (typeof INSTITUTIONS)[number];
}

export class InvalidCardError extends Error {}

export const parseCardInput = (rawBody: string | undefined): CardInput => {
  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    throw new InvalidCardError('Request body must be a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidCardError('Request body must be a JSON object.');
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 100) {
    throw new InvalidCardError('name must be between 1 and 100 characters.');
  }
  if (!Number.isInteger(body.cutOffDay) || Number(body.cutOffDay) < 1 || Number(body.cutOffDay) > 31) {
    throw new InvalidCardError('cutOffDay must be an integer between 1 and 31.');
  }
  if (!Number.isInteger(body.paymentDueDay) || Number(body.paymentDueDay) < 1 || Number(body.paymentDueDay) > 31) {
    throw new InvalidCardError('paymentDueDay must be an integer between 1 and 31.');
  }
  let institution: CardInput['institution'];
  if (body.institution !== undefined && body.institution !== null && body.institution !== '') {
    if (typeof body.institution !== 'string' || !isInstitution(body.institution)) {
      throw new InvalidCardError('institution is invalid.');
    }
    if (body.institution === 'amazon_web_services') {
      throw new InvalidCardError('institution must be a card issuer.');
    }
    institution = body.institution;
  }
  return {
    name: body.name.trim(),
    cutOffDay: Number(body.cutOffDay),
    paymentDueDay: Number(body.paymentDueDay),
    ...(institution ? { institution } : {}),
  };
};

export const isValidCardId = (cardId: string): boolean =>
  typeof cardId === 'string' && cardId.length >= 1 && cardId.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(cardId);

/** Card mutations use domain keys and typed SQL columns in the shared domain transaction. */
export const saveCard = async (input: {
  readonly owner: string; readonly cardId: string; readonly body: CardInput;
}): Promise<CardRecord> => {
  if (!isValidCardId(input.cardId)) throw new InvalidCardError('cardId is invalid.');
  const body = parseCardInput(JSON.stringify(input.body));
  return withApplicationTransaction(async () => {
    const client = applicationStoreClient();
    const existing = (await client.query('SELECT owner,created_at,deleted_at FROM olbia.card_profiles WHERE id=$1', [input.cardId])).rows[0];
    if (existing && existing.owner !== input.owner) throw new InvalidCardError('Card not found.');
    if (!existing || existing.deleted_at !== null) {
      const count = Number((await client.query('SELECT count(*) AS count FROM olbia.card_profiles WHERE owner=$1 AND deleted_at IS NULL', [input.owner])).rows[0]?.count);
      if (count >= MAX_CARDS) throw new InvalidCardError(`At most ${MAX_CARDS} cards are allowed.`);
    }
    const now = new Date().toISOString();
    const createdAt = existing && existing.deleted_at === null ? existing.created_at : now;
    const row = (await client.query(`INSERT INTO olbia.card_profiles
      (id,owner,name,cut_off_day,payment_due_day,institution,created_at,updated_at,deleted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL) ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name,cut_off_day=EXCLUDED.cut_off_day,payment_due_day=EXCLUDED.payment_due_day,
      institution=EXCLUDED.institution,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted_at=NULL
      WHERE olbia.card_profiles.owner=EXCLUDED.owner RETURNING *`,
    [input.cardId, input.owner, body.name, body.cutOffDay, body.paymentDueDay, body.institution ?? null, createdAt, now])).rows[0];
    if (!row) throw new InvalidCardError('Card not found.');
    return toNativeCardRecord(row);
  });
};

/** Retain identity for historical liability FKs; current readers omit inactive profiles. */
export const deleteCard = async (input: { readonly owner: string; readonly cardId: string }): Promise<void> => {
  if (!isValidCardId(input.cardId)) throw new InvalidCardError('cardId is invalid.');
  await withApplicationTransaction(async () => {
    await applicationStoreClient().query(`UPDATE olbia.card_profiles SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=$1 AND owner=$2 AND deleted_at IS NULL`, [input.cardId, input.owner]);
  });
};

export const toPublicCard = (card: CardRecord): Record<string, unknown> => ({
  id: card.id,
  name: card.name,
  cutOffDay: card.cutOffDay,
  paymentDueDay: card.paymentDueDay,
  ...(card.institution ? { institution: card.institution } : {}),
  createdAt: card.createdAt,
  updatedAt: card.updatedAt,
});
