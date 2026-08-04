import { describe, expect, it } from 'vitest';
import {
  cardCyclePushMessage,
  cardRemindersForDay,
  clampDayInMonth,
} from '@finance/domain';
import { InvalidCardError, MAX_CARDS, parseCardInput } from '../src/cards/cards.js';

describe('clampDayInMonth', () => {
  it('clamps day 31 into February', () => {
    expect(clampDayInMonth(31, '2026-02')).toBe(28);
  });

  it('keeps valid days unchanged', () => {
    expect(clampDayInMonth(15, '2026-08')).toBe(15);
  });
});

describe('cardRemindersForDay', () => {
  const cards = [
    { id: 'card-amex', name: 'Amex', cutOffDay: 15, paymentDueDay: 3 },
    { id: 'card-nu', name: 'Nu', cutOffDay: 28, paymentDueDay: 15 },
  ];

  it('returns cutoff and payment matches for the day', () => {
    expect(cardRemindersForDay(cards, '2026-08', 15)).toEqual([
      { cardId: 'card-amex', name: 'Amex', kind: 'cutoff' },
      { cardId: 'card-nu', name: 'Nu', kind: 'payment' },
    ]);
  });

  it('clamps February cutoffs', () => {
    expect(cardRemindersForDay(
      [{ id: 'card-amex', name: 'Amex', cutOffDay: 31, paymentDueDay: 5 }],
      '2026-02',
      28,
    )).toEqual([{ cardId: 'card-amex', name: 'Amex', kind: 'cutoff' }]);
  });
});

describe('cardCyclePushMessage', () => {
  it('includes the card name by default', () => {
    expect(cardCyclePushMessage(
      { cardId: 'card-1', name: 'Amex Gold', kind: 'payment' },
      'amounts',
      'https://finance.castrodavid.dev/',
      '2026-08-03',
    )).toEqual({
      title: 'Olbia · pago hoy',
      body: 'Amex Gold: día de pago.',
      tag: 'card-payment-card-1-2026-08-03',
      navigate: 'https://finance.castrodavid.dev/',
    });
  });

  it('hides the card name in private mode', () => {
    expect(cardCyclePushMessage(
      { cardId: 'card-1', name: 'Amex Gold', kind: 'cutoff' },
      'private',
      'https://finance.castrodavid.dev/',
      '2026-08-15',
    ).body).toBe('Hoy es día de corte.');
  });
});

describe('parseCardInput', () => {
  it('accepts a valid card payload', () => {
    expect(parseCardInput(JSON.stringify({
      name: 'Amex Gold',
      cutOffDay: 15,
      paymentDueDay: 3,
      institution: 'american_express_mx',
    }))).toEqual({
      name: 'Amex Gold',
      cutOffDay: 15,
      paymentDueDay: 3,
      institution: 'american_express_mx',
    });
  });

  it('rejects aws as a card institution', () => {
    expect(() => parseCardInput(JSON.stringify({
      name: 'AWS',
      cutOffDay: 1,
      paymentDueDay: 2,
      institution: 'amazon_web_services',
    }))).toThrow(InvalidCardError);
  });

  it('documents the max card limit constant', () => {
    expect(MAX_CARDS).toBe(3);
  });
});
