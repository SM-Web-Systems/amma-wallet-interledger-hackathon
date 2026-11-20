import { describe, expect, it } from 'vitest';
import { startPaymentRuntime } from './start';
import { PaymentFault } from './domain';

describe('startPaymentRuntime', () => {
  it('keeps the API up with payments disabled when Rafiki cannot be reached', async () => {
    const lines: string[] = [];
    const runtime = await startPaymentRuntime(async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:3001 secret=abc'), { code: 'ECONNREFUSED' }); }, l => lines.push(l));
    expect(runtime).toBeNull();
    expect(lines).toEqual([JSON.stringify({ event: 'payments_runtime_unavailable', code: 'ECONNREFUSED' })]);
  });

  it('logs only a safe code for bad settings or odd errors, never the message', async () => {
    const lines: string[] = [];
    await startPaymentRuntime(async () => { throw new PaymentFault('PAYMENT_SECRET_TOO_SHORT'); }, l => lines.push(l));
    await startPaymentRuntime(async () => { throw Object.assign(new Error('x'), { code: 'https://user:pw@host' }); }, l => lines.push(l));
    await startPaymentRuntime(async () => { throw 'boom'; }, l => lines.push(l));
    expect(lines.map(l => JSON.parse(l).code)).toEqual(['PAYMENT_SECRET_TOO_SHORT', 'PAYMENT_RUNTIME_START_FAILED', 'PAYMENT_RUNTIME_START_FAILED']);
  });

  it('passes a healthy runtime, or payments switched off, straight through', async () => {
    const healthy = { close: async () => {} };
    expect(await startPaymentRuntime(async () => healthy, () => { throw new Error('should not log'); })).toBe(healthy);
    expect(await startPaymentRuntime(async () => null, () => { throw new Error('should not log'); })).toBeNull();
  });
});
