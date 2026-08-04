import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { INSTITUTIONS, isInstitution } from '@finance/domain';

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

export const cardKey = (owner: string, cardId: string): { readonly PK: string; readonly SK: string } => ({
  PK: `USER#${owner}`,
  SK: `CARD#${cardId}`,
});

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

export const listCards = async (input: {
  readonly database: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly owner: string;
}): Promise<readonly CardRecord[]> => {
  const cards: CardRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await input.database.send(new QueryCommand({
      TableName: input.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `USER#${input.owner}`,
        ':prefix': 'CARD#',
      },
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
    }));
    for (const item of result.Items ?? []) {
      const record = toCardRecord(item);
      if (record) cards.push(record);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return [...cards].sort((left, right) => left.name.localeCompare(right.name, 'es') || left.id.localeCompare(right.id));
};

export const saveCard = async (input: {
  readonly database: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly owner: string;
  readonly cardId: string;
  readonly body: CardInput;
}): Promise<CardRecord> => {
  if (!isValidCardId(input.cardId)) {
    throw new InvalidCardError('cardId is invalid.');
  }
  const key = cardKey(input.owner, input.cardId);
  const existing = await input.database.send(new GetCommand({
    TableName: input.tableName,
    Key: key,
    ConsistentRead: true,
  }));
  const now = new Date().toISOString();
  const isCreate = !existing.Item;
  if (isCreate) {
    const current = await listCards({
      database: input.database,
      tableName: input.tableName,
      owner: input.owner,
    });
    if (current.length >= MAX_CARDS) {
      throw new InvalidCardError(`At most ${MAX_CARDS} cards are allowed.`);
    }
  }
  const createdAt = typeof existing.Item?.createdAt === 'string' ? existing.Item.createdAt : now;
  const record: CardRecord = {
    id: input.cardId,
    name: input.body.name,
    cutOffDay: input.body.cutOffDay,
    paymentDueDay: input.body.paymentDueDay,
    ...(input.body.institution ? { institution: input.body.institution } : {}),
    createdAt,
    updatedAt: now,
  };
  await input.database.send(new PutCommand({
    TableName: input.tableName,
    Item: {
      ...key,
      entityType: 'card_cycle',
      owner: input.owner,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      payload: {
        id: record.id,
        name: record.name,
        cutOffDay: record.cutOffDay,
        paymentDueDay: record.paymentDueDay,
        ...(record.institution ? { institution: record.institution } : {}),
      },
    },
  }));
  return record;
};

export const deleteCard = async (input: {
  readonly database: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly owner: string;
  readonly cardId: string;
}): Promise<void> => {
  if (!isValidCardId(input.cardId)) {
    throw new InvalidCardError('cardId is invalid.');
  }
  await input.database.send(new DeleteCommand({
    TableName: input.tableName,
    Key: cardKey(input.owner, input.cardId),
  }));
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

const toCardRecord = (item: Record<string, unknown>): CardRecord | undefined => {
  const payload = item.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  if (typeof body.id !== 'string' || typeof body.name !== 'string') return undefined;
  if (!Number.isInteger(body.cutOffDay) || !Number.isInteger(body.paymentDueDay)) return undefined;
  const institution = typeof body.institution === 'string' && isInstitution(body.institution)
    && body.institution !== 'amazon_web_services'
    ? body.institution
    : undefined;
  return {
    id: body.id,
    name: body.name,
    cutOffDay: Number(body.cutOffDay),
    paymentDueDay: Number(body.paymentDueDay),
    ...(institution ? { institution } : {}),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString(),
  };
};
