import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { normaliseMerchant, reconciliationPartition, saveObservedEvent, type SaveObservedEventInput } from '../lambda/observed-events.js';

const event = {
  id: 'apple-event-1',
  institution: 'santander_mx',
  eventType: 'card_purchase',
  status: 'accepted',
  amount: { amountMinor: 11500, currency: 'MXN' },
  merchantRaw: 'ZARA CHIHUAHUA',
  occurredAt: '2026-08-02T01:30:00.000Z',
  receivedAt: '2026-08-02T01:30:02.000Z',
  ingestedAt: '2026-08-02T01:30:02.000Z',
  source: { kind: 'apple_pay_shortcut', requestId: 'capture-1' },
  parserVersion: 'apple-pay-shortcut-v1',
  parseWarnings: [],
};

const inputWith = (send: ReturnType<typeof vi.fn>): SaveObservedEventInput => ({
  database: { send } as unknown as DynamoDBDocumentClient,
  tableName: 'metadata',
  dedupeKey: 'apple_pay_shortcut:capture-1',
  captureSource: 'apple_pay_shortcut',
  event,
  reconciliationAt: event.occurredAt,
});

describe('observed event persistence', () => {
  it('normalises merchants and builds stable reconciliation partitions', () => {
    expect(normaliseMerchant(' Café—México #42 ')).toBe('CAFE MEXICO 42');
    expect(reconciliationPartition(event)).toBe('RECON#santander_mx#card_purchase#MXN#11500');
  });

  it('atomically creates a primary event, observation, and dedupe claim', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});
    const saved = await saveObservedEvent(inputWith(send));
    expect(saved).toMatchObject({ eventId: 'apple-event-1', created: true, reconciled: false, duplicate: false });
    const transaction = send.mock.calls[1][0].input;
    expect(transaction.TransactItems).toHaveLength(3);
    expect(transaction.TransactItems[1].Put.Item).toMatchObject({
      PK: 'EVENT#apple-event-1',
      SK: 'EVENT',
      GSI2PK: 'RECON#santander_mx#card_purchase#MXN#11500',
    });
  });

  it('atomically links a unique email and Apple Pay match', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Items: [{
        reconciliationAt: '2026-08-02T01:31:00.000Z',
        payload: { id: 'email-event-1', merchantRaw: 'Zara Chihuahua', captureSources: ['email'] },
      }] })
      .mockResolvedValueOnce({});
    const saved = await saveObservedEvent(inputWith(send));
    expect(saved).toMatchObject({ eventId: 'email-event-1', created: false, reconciled: true, duplicate: false });
    const transaction = send.mock.calls[1][0].input;
    expect(transaction.TransactItems).toHaveLength(3);
    expect(transaction.TransactItems[1].Put.Item.PK).toBe('EVENT#email-event-1');
    expect(transaction.TransactItems[2].Update.Key).toEqual({ PK: 'EVENT#email-event-1', SK: 'EVENT' });
  });

  it('marks raw email as available when email becomes a linked observation', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Items: [{
        reconciliationAt: '2026-08-02T01:29:00.000Z',
        payload: { id: 'apple-event-1', merchantRaw: 'ZARA CHIHUAHUA', captureSources: ['apple_pay_shortcut'] },
      }] })
      .mockResolvedValueOnce({});
    const emailInput: SaveObservedEventInput = {
      ...inputWith(send),
      dedupeKey: 'email:message-1',
      captureSource: 'email',
      event: {
        ...event,
        id: 'email-event-1',
        source: { bucket: 'raw-email', key: 'inbound/message-1', contentType: 'message/rfc822' },
        parserVersion: 'santander-email-v1',
      },
    };
    const saved = await saveObservedEvent(emailInput);
    expect(saved).toMatchObject({ eventId: 'apple-event-1', reconciled: true });
    const update = send.mock.calls[1][0].input.TransactItems[2].Update;
    expect(update.UpdateExpression).toContain('#payload.#hasRawEmail = :true');
    expect(update.ExpressionAttributeValues[':true']).toBe(true);
  });

  it('reconciles a delayed Santander email with a same-day CSV observation', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Items: [{
        reconciliationAt: '2026-08-02T12:00:00.000Z',
        payload: {
          id: 'csv-event-1',
          merchantRaw: 'AMAZON WEB SERV',
          occurredAt: '2026-08-02T12:00:00.000Z',
          account: { lastFour: '6349' },
          captureSources: ['santander_csv'],
        },
      }] })
      .mockResolvedValueOnce({});
    const emailInput: SaveObservedEventInput = {
      ...inputWith(send),
      dedupeKey: 'email:delayed-message',
      captureSource: 'email',
      reconciliationAt: '2026-08-03T01:45:00.000Z',
      event: {
        ...event,
        id: 'email-event-delayed',
        merchantRaw: 'AMAZON WEB SERVICES',
        occurredAt: '2026-08-02T12:00:00.000Z',
        account: { lastFour: '6349' },
        source: { bucket: 'raw-email', key: 'inbound/delayed', contentType: 'message/rfc822' },
        parserVersion: 'santander-email-v1',
      },
    };
    await expect(saveObservedEvent(emailInput)).resolves.toMatchObject({
      eventId: 'csv-event-1', created: false, reconciled: true,
    });
    const query = send.mock.calls[0][0].input;
    const to = String(query.ExpressionAttributeValues[':to']).replace('\uffff', '');
    expect(Date.parse(to) - Date.parse(query.ExpressionAttributeValues[':from'])).toBe(36 * 60 * 60 * 1000);
  });

  it('reconciles a delayed Amex email with a same-day manual observation', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Items: [{
        reconciliationAt: '2026-08-01T12:00:00.000Z',
        payload: {
          id: 'manual-event-1',
          merchantRaw: 'AMAZON MX',
          occurredAt: '2026-08-01T12:00:00.000Z',
          account: { lastFour: '1234' },
          captureSources: ['manual'],
        },
      }] })
      .mockResolvedValueOnce({});
    const emailInput: SaveObservedEventInput = {
      ...inputWith(send),
      dedupeKey: 'email:amex-delayed',
      captureSource: 'email',
      reconciliationAt: '2026-08-02T01:10:00.000Z',
      event: {
        ...event,
        id: 'email-amex-1',
        institution: 'american_express_mx',
        merchantRaw: 'AMAZON MX',
        occurredAt: '2026-08-01T18:40:00.000Z',
        account: { lastFour: '1234' },
        source: { bucket: 'raw-email', key: 'inbound/amex', contentType: 'message/rfc822' },
        parserVersion: 'amex-mx-card-purchase-v2',
      },
    };
    await expect(saveObservedEvent(emailInput)).resolves.toMatchObject({
      eventId: 'manual-event-1', created: false, reconciled: true,
    });
  });

  it('does not reconcile a manual observation from a different calendar day', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Items: [{
        reconciliationAt: '2026-07-31T12:00:00.000Z',
        payload: {
          id: 'manual-previous-day',
          merchantRaw: 'AMAZON MX',
          occurredAt: '2026-07-31T12:00:00.000Z',
          captureSources: ['manual'],
        },
      }] })
      .mockResolvedValueOnce({});
    const emailInput: SaveObservedEventInput = {
      ...inputWith(send),
      dedupeKey: 'email:amex-other-day',
      captureSource: 'email',
      reconciliationAt: '2026-08-01T20:00:00.000Z',
      event: {
        ...event,
        id: 'email-amex-other-day',
        institution: 'american_express_mx',
        merchantRaw: 'AMAZON MX',
        occurredAt: '2026-08-01T18:00:00.000Z',
        source: { bucket: 'raw-email', key: 'inbound/amex-2', contentType: 'message/rfc822' },
        parserVersion: 'amex-mx-card-purchase-v2',
      },
    };
    await expect(saveObservedEvent(emailInput)).resolves.toMatchObject({ created: true, reconciled: false });
  });

  it('does not reconcile a CSV observation from a different calendar day', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Items: [{
        reconciliationAt: '2026-08-01T12:00:00.000Z',
        payload: {
          id: 'csv-event-previous-day',
          merchantRaw: 'AMAZON WEB SERV',
          occurredAt: '2026-08-01T12:00:00.000Z',
          account: { lastFour: '6349' },
          captureSources: ['santander_csv'],
        },
      }] })
      .mockResolvedValueOnce({});
    const csvInput: SaveObservedEventInput = {
      ...inputWith(send),
      captureSource: 'santander_csv',
      reconciliationAt: '2026-08-02T12:00:00.000Z',
      event: {
        ...event,
        account: { lastFour: '6349' },
        merchantRaw: 'AMAZON WEB SERVICES',
        occurredAt: '2026-08-02T12:00:00.000Z',
      },
    };
    await expect(saveObservedEvent(csvInput)).resolves.toMatchObject({ created: true, reconciled: false });
  });

  it('does not infer a match when multiple cross-source candidates are plausible', async () => {
    const candidate = (id: string) => ({
      reconciliationAt: '2026-08-02T01:31:00.000Z',
      payload: { id, merchantRaw: 'ZARA CHIHUAHUA', captureSources: ['email'] },
    });
    const send = vi.fn().mockResolvedValueOnce({ Items: [candidate('email-1'), candidate('email-2')] }).mockResolvedValueOnce({});
    const saved = await saveObservedEvent(inputWith(send));
    expect(saved).toMatchObject({ eventId: 'apple-event-1', created: true, reconciled: false });
  });

  it('treats a second same-source observation within two minutes as a defensive retry', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Items: [{
        reconciliationAt: '2026-08-02T01:31:00.000Z',
        payload: {
          id: 'apple-event-existing',
          merchantRaw: 'ZARA CHIHUAHUA',
          captureSources: ['apple_pay_shortcut'],
          primaryObservationId: 'primary-observation',
        },
      }] })
      .mockResolvedValueOnce({});
    await expect(saveObservedEvent(inputWith(send))).resolves.toEqual({
      eventId: 'apple-event-existing',
      observationId: 'primary-observation',
      duplicate: true,
      reconciled: false,
      created: false,
    });
    expect(send.mock.calls[1][0].input.TransactItems).toHaveLength(1);
  });

  it('returns the original result when an idempotency claim already exists', async () => {
    const canceled = new Error('cancelled');
    canceled.name = 'TransactionCanceledException';
    const send = vi.fn()
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(canceled)
      .mockResolvedValueOnce({ Item: {
        eventId: 'existing-event', observationId: 'existing-observation', reconciled: true,
      } });
    await expect(saveObservedEvent(inputWith(send))).resolves.toEqual({
      eventId: 'existing-event',
      observationId: 'existing-observation',
      duplicate: true,
      reconciled: true,
      created: false,
    });
  });
});
