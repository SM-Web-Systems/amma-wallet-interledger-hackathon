/**
 * Start payments without letting them take the rest of the API down. If Rafiki
 * is unreachable or the payment settings are wrong, the API still boots with
 * payments disabled (routes answer 503 PAYMENTS_DISABLED) and logs why, so XRP,
 * Stellar and sign-in keep working. Payments come back on the next restart once
 * Rafiki is healthy. Only an error code is logged, never a message, URL or secret.
 */
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;

export async function startPaymentRuntime<T>(create: () => Promise<T | null>, warn: (line: string) => void = console.error): Promise<T | null> {
  try { return await create(); }
  catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    warn(JSON.stringify({ event: 'payments_runtime_unavailable', code: typeof code === 'string' && SAFE_CODE.test(code) ? code : 'PAYMENT_RUNTIME_START_FAILED' }));
    return null;
  }
}
