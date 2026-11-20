import { describe, expect, it } from 'vitest';
import { actionsLabel, executionStatus, grantAmount, grantInterval, otherConditions, sourceReason } from './payment-display';

describe('payment display helpers', () => {
  it('formats Open Payments amounts with their scale', () => {
    expect(grantAmount({ value: '50000', assetCode: 'ZAR', assetScale: 2 })).toBe('500 ZAR');
    expect(grantAmount({ value: '12345', assetCode: 'USD', assetScale: 2 })).toBe('123.45 USD');
    expect(grantAmount({ value: '5', assetCode: 'XRP', assetScale: 6 })).toBe('0.000005 XRP');
    expect(grantAmount(undefined)).toBeNull();
  });

  it('describes repeating intervals in words', () => {
    expect(grantInterval('R/2026-11-03T00:00:00Z/P1M')).toMatch(/^every month, starting /);
    expect(grantInterval('P1D')).toBe('every day');
    expect(grantInterval(undefined)).toBeNull();
  });

  it('turns codes into readable labels and keeps unknown ones legible', () => {
    expect(actionsLabel(['create', 'read', 'list'])).toBe('Create, view and list');
    expect(executionStatus('paid')).toEqual({ label: 'Payment complete', tone: 'success' });
    expect(executionStatus('NEW_STATE').label).toBe('New state');
    expect(sourceReason('RESTORE_WALLET_ON_THIS_DEVICE')).toBe('Restore this wallet on this device to use it');
    expect(sourceReason('SOMETHING_ELSE')).toBe('Something else');
  });
});

describe('otherConditions (the consent screen must not drop anything)', () => {
  const recognised = {
    type: 'outgoing-payment',
    identifier: 'https://wallet.example/alice',
    actions: ['create', 'read'],
    limits: { debitAmount: { value: '5000', assetCode: 'USD', assetScale: 2 }, interval: 'R/2026-11-03T00:00:00Z/P1M', receiver: 'https://shop.example/bob' },
  };

  it('returns nothing for a fully recognised grant', () => {
    expect(otherConditions(recognised)).toEqual([]);
  });

  it('lists unknown limit keys and unknown access fields verbatim', () => {
    const out = otherConditions({ ...recognised, limits: { ...recognised.limits, maxPayments: 3 }, expires: '2027-01-01' });
    expect(out).toContainEqual(['limits.maxPayments', '3']);
    expect(out).toContainEqual(['expires', '2027-01-01']);
  });

  it('lists an amount that cannot be formatted instead of hiding it', () => {
    const out = otherConditions({ type: 'outgoing-payment', limits: { debitAmount: { value: '10' } } });
    expect(out).toEqual([['limits.debitAmount', '{"value":"10"}']]);
  });

  it('lists an interval or receiver that is not a string', () => {
    const out = otherConditions({ type: 'quote', limits: { interval: { every: 'month' }, receiver: 42 } });
    expect(out).toContainEqual(['limits.interval', '{"every":"month"}']);
    expect(out).toContainEqual(['limits.receiver', '42']);
  });
});
