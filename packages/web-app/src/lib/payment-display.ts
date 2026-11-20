// Human-readable labels for the everyday-payments and consent screens.
// Display only: nothing here changes what is sent to the payments API.

export type Tone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

const CHAINS: Record<string, string> = { stellar: 'Stellar', xrpl: 'XRP Ledger', fiat: 'Bank balance' };
export function chainLabel(chain: string): string {
  return CHAINS[chain] ?? chain;
}

const EXECUTION: Record<string, { label: string; tone: Tone }> = {
  funding: { label: 'Confirming funding', tone: 'progress' },
  ready: { label: 'Funding confirmed', tone: 'progress' },
  paying: { label: 'Sending payment', tone: 'progress' },
  paid: { label: 'Payment complete', tone: 'success' },
  recovery: { label: 'Payment needs recovery', tone: 'warning' },
  recovered: { label: 'Funds available in your Amma balance', tone: 'neutral' },
  failed: { label: 'Payment failed', tone: 'danger' },
};
export function executionStatus(state: string): { label: string; tone: Tone } {
  return EXECUTION[state] ?? { label: humanise(state), tone: 'neutral' };
}

const SHORT_EXECUTION: Record<string, string> = {
  funding: 'In progress', ready: 'In progress', paying: 'Sending', paid: 'Paid',
  recovery: 'Needs attention', recovered: 'Refunded to balance', failed: 'Failed',
};
export function executionShortLabel(state: string): string {
  return SHORT_EXECUTION[state] ?? humanise(state);
}

const LEG: Record<string, { label: string; tone: Tone }> = {
  planned: { label: 'Planned', tone: 'neutral' },
  prepared: { label: 'Needs your signature', tone: 'warning' },
  pending: { label: 'Pending', tone: 'progress' },
  submitted: { label: 'Submitted', tone: 'progress' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  unknown: { label: 'Checking', tone: 'progress' },
};
export function legStatus(state: string): { label: string; tone: Tone } {
  return LEG[state] ?? { label: humanise(state), tone: 'neutral' };
}

const SOURCE_REASONS: Record<string, string> = {
  RESTORE_WALLET_ON_THIS_DEVICE: 'Restore this wallet on this device to use it',
  ASSET_NOT_AUTHORIZED: 'Not yet authorised by the asset issuer',
  FROZEN: 'Temporarily unavailable',
};
export function sourceReason(reason: string): string {
  return SOURCE_REASONS[reason] ?? humanise(reason);
}

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-stellar-muted/15 text-stellar-text',
  progress: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  success: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  danger: 'bg-red-500/15 text-red-700 dark:text-red-300',
};

function humanise(code: string): string {
  const text = code.replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Open Payments grant access (consent screen) ──────────────────────

const ACCESS_TYPES: Record<string, string> = {
  'outgoing-payment': 'Send payments from your account',
  'incoming-payment': 'Receive payments into your account',
  quote: 'Get payment quotes',
};
export function accessTypeLabel(type: string): string {
  return ACCESS_TYPES[type] ?? humanise(type.replaceAll('-', '_'));
}

const ACTIONS: Record<string, string> = {
  create: 'create', read: 'view', 'read-all': 'view all', list: 'list', 'list-all': 'list all', complete: 'complete',
};
export function actionsLabel(actions: string[] | undefined): string {
  if (!actions?.length) return '';
  const words = actions.map(a => ACTIONS[a] ?? a);
  const text = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0];
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type GrantAmount = { value?: string | number; assetCode?: string; assetScale?: number };
export function grantAmount(amount: GrantAmount | undefined): string | null {
  if (!amount || amount.value === undefined || !amount.assetCode) return null;
  const scale = Number(amount.assetScale ?? 0);
  const raw = String(amount.value);
  if (!/^\d+$/.test(raw) || !Number.isInteger(scale) || scale < 0 || scale > 30) return `${raw} ${amount.assetCode}`;
  const digits = raw.padStart(scale + 1, '0');
  const whole = scale ? digits.slice(0, -scale) : digits;
  const fraction = scale ? digits.slice(-scale).replace(/0+$/, '') : '';
  return `${whole}${fraction ? `.${fraction}` : ''} ${amount.assetCode}`;
}

const PERIODS: Record<string, string> = { P1D: 'day', P1W: 'week', P7D: 'week', P1M: 'month', P1Y: 'year' };
/** Turns an ISO 8601 repeating interval such as `R/2026-11-03T00:00:00Z/P1M` into "every month". */
export function grantInterval(interval: string | undefined): string | null {
  if (!interval) return null;
  const parts = interval.split('/');
  const period = parts.at(-1) ?? '';
  const start = parts.length === 3 ? Date.parse(parts[1]) : NaN;
  const every = PERIODS[period] ? `every ${PERIODS[period]}` : `per ${period}`;
  return Number.isNaN(start) ? every : `${every}, starting ${new Date(start).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// Anything in a grant the screen has no dedicated wording for. A consent screen must never
// show less than what is being granted, so these are listed verbatim instead of dropped.
const KNOWN_ITEM_KEYS = new Set(['type', 'identifier', 'actions', 'limits']);
const KNOWN_LIMIT_KEYS = new Set(['debitAmount', 'receiveAmount', 'interval', 'receiver']);
function show(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
export function otherConditions(item: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(item)) {
    if (!KNOWN_ITEM_KEYS.has(key) && value !== undefined) out.push([key, show(value)]);
  }
  const limits = (item.limits && typeof item.limits === 'object' ? item.limits : {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(limits)) {
    if (!KNOWN_LIMIT_KEYS.has(key) && value !== undefined) out.push([`limits.${key}`, show(value)]);
  }
  for (const key of ['debitAmount', 'receiveAmount']) {
    if (limits[key] !== undefined && grantAmount(limits[key] as GrantAmount) === null) out.push([`limits.${key}`, show(limits[key])]);
  }
  if (limits.interval !== undefined && typeof limits.interval !== 'string') out.push(['limits.interval', show(limits.interval)]);
  if (limits.receiver !== undefined && typeof limits.receiver !== 'string') out.push(['limits.receiver', show(limits.receiver)]);
  return out;
}

// ── Failed payments: a plain sentence and a next step (G-15) ─────────

type ErrorText = { message: string; action?: string };

const RETURN_FUNDS = 'use “Return available funds to Amma balance”, then start again.';
const RATE_CHANGED: ErrorText = {
  message: 'The conversion rate changed.',
  action: 'Get a new quote. If your funds were already moved, first ' + RETURN_FUNDS,
};
const UNAVAILABLE: ErrorText = { message: 'Payments are temporarily unavailable.', action: 'Try again in a few minutes.' };
const NOT_FOUND: ErrorText = { message: 'We could not find this payment.', action: 'Check the link, or ask the shop for a new QR code or link.' };
const STILL_PROCESSING: ErrorText = {
  message: 'Your payment is still being processed.',
  action: 'Wait a few minutes and check your payment history before trying again.',
};

const PAYMENT_ERRORS: Record<string, ErrorText> = {
  INSUFFICIENT_SPENDABLE_LIQUIDITY: {
    message: 'Your available funds cannot cover this payment, including network fees.',
    action: 'Check your balances, add funds if needed, then get a new quote.',
  },
  INSUFFICIENT_AVAILABLE_BALANCE: {
    message: 'You do not have enough available funds to cover this payment.',
    action: 'Add funds, then get a new quote.',
  },
  INVOICE_ALREADY_IN_PROGRESS: { message: 'This payment is already being processed.', action: 'Check your payment history before trying again.' },
  QUOTE_ALREADY_APPROVED: { message: 'This quote was already approved.', action: 'Check your payment history before trying again.' },
  IDEMPOTENCY_CONFLICT: {
    message: 'This payment was already submitted with different details.',
    action: 'Check your payment history, then start a new payment.',
  },
  PAYMENT_UNRESOLVED: STILL_PROCESSING,
  FUNDING_UNRESOLVED: STILL_PROCESSING,
  FUNDING_NOT_READY: { message: 'Funding for this payment is not ready yet.', action: 'Wait a moment, then try again.' },
  INVOICE_EXPIRED: { message: 'This payment request has expired.', action: 'Ask the shop for a new QR code or link.' },
  QUOTE_EXPIRED: { message: 'The price quote has expired.', action: 'Refresh the quote and approve again.' },
  PARTNER_QUOTE_CHANGED: RATE_CHANGED,
  FUNDING_QUOTE_CHANGED: RATE_CHANGED,
  FIVEWEST_QUOTE_EXPIRED: RATE_CHANGED,
  FIVEWEST_QUOTE_MISMATCH: RATE_CHANGED,
  QUOTE_EXCEEDS_APPROVAL: {
    message: 'The price changed, or the approval ran out of time, before the payment finished.',
    action: 'Your funds are held for you: ' + RETURN_FUNDS,
  },
  APPROVAL_EXPIRED: { message: 'This payment took too long to finish.', action: 'If your funds were moved, ' + RETURN_FUNDS },
  PAYMENTS_PAUSED: { message: 'Payments are paused for a short while.', action: 'Try again later.' },
  PAYMENTS_DISABLED: { message: 'Payments are not available here.' },
  PAYMENT_LIMIT_EXCEEDED: { message: 'This payment is over the limit for a single payment.', action: 'Try a smaller amount.' },
  DAILY_PAYMENT_LIMIT_EXCEEDED: { message: 'This payment is over your daily limit.', action: 'Try a smaller amount, or try again tomorrow.' },
  USER_SESSION_REQUIRED: { message: 'Your session has ended.', action: 'Sign in again.' },
  NOT_FOUND: NOT_FOUND,
  PAYMENT_NOT_FOUND: NOT_FOUND,
  INVALID_ID: NOT_FOUND,
  INVALID_INVOICE: { message: 'The payment request details are not valid.', action: 'Ask the shop for a new QR code or link.' },
  INVALID_REQUEST: { message: 'Some details in the request are not valid.', action: 'Check them and try again.' },
  RECOVERY_NOT_AVAILABLE: {
    message: 'Your funds cannot be returned right now, or they were already returned.',
    action: 'Check your payment history, then try again if needed.',
  },
  CONVERSION_UNAVAILABLE: UNAVAILABLE,
  PARTNER_UNAVAILABLE: UNAVAILABLE,
  ADAPTER_UNAVAILABLE: UNAVAILABLE,
  RAFIKI_UNAVAILABLE: UNAVAILABLE,
  IDENTITY_UNAVAILABLE: UNAVAILABLE,
  PAYMENT_SERVICE_UNAVAILABLE: {
    message: 'Something went wrong on our side, and your payment may still be in progress.',
    action: 'Check your payment history before trying again.',
  },
};

const looksLikeCode = (text: string) => /^[A-Z][A-Z0-9_ ]{2,}$/.test(text);

/**
 * One sentence and a next step for a failed payment call or a failed execution.
 * Backend codes arrive as the error message with spaces for underscores, and on `error.code` when the client kept it.
 * An unknown code is never the headline; it stays as a reference to quote to support.
 */
export function paymentErrorText(err: unknown): string {
  const raw = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
  const explicit = (err as { code?: unknown } | null)?.code;
  const code = typeof explicit === 'string' && explicit ? explicit : looksLikeCode(raw.trim()) ? raw.trim().replaceAll(' ', '_') : '';
  if (!code) {
    return raw || 'We could not complete this payment. Try again in a moment.';
  }
  const known = PAYMENT_ERRORS[code];
  if (known) return known.action ? `${known.message} ${known.action}` : known.message;
  return `We could not complete this payment. Try again in a moment. If it keeps happening, contact support and quote: ${code}`;
}
