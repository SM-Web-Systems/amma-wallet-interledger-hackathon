import { createHash, randomUUID } from 'node:crypto';

export class PaymentFault extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export function requireThat(ok: unknown, code: string, status = 400): asserts ok {
  if (!ok) throw new PaymentFault(code, status);
}
export function units(value: unknown, zero = false): bigint {
  requireThat(typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value), 'INVALID_AMOUNT');
  const result = BigInt(value);
  requireThat(zero || result > 0n, 'INVALID_AMOUNT');
  return result;
}
export function decimal(value: string, scale: number): bigint {
  requireThat(Number.isInteger(scale) && scale >= 0 && scale <= 18, 'INVALID_SCALE');
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  requireThat(match && (match[2]?.length ?? 0) <= scale, 'INVALID_AMOUNT');
  return units(BigInt(match[1] + (match[2] ?? '').padEnd(scale, '0')).toString(), true);
}
export function display(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}
export const ceil = (n: bigint, d: bigint) => { requireThat(d > 0n && n >= 0n, 'INVALID_RATE'); return (n + d - 1n) / d; };
export type Asset = { chain: 'stellar' | 'xrpl' | 'fiat'; network: string; code: string; issuer?: string; scale: number };
export const assetEnvironment=(asset:Asset)=>['testnet','sandbox'].includes(asset.network)?'test':'live';
export function assetKey(asset: Asset): string {
  requireThat(['stellar', 'xrpl', 'fiat'].includes(asset.chain) && /^[a-z0-9-]{1,32}$/.test(asset.network)
    && /^[A-Za-z0-9]{1,40}$/.test(asset.code) && Number.isInteger(asset.scale) && asset.scale >= 0 && asset.scale <= 18, 'INVALID_ASSET');
  requireThat(!asset.issuer || /^[A-Za-z0-9]{1,128}$/.test(asset.issuer), 'INVALID_ISSUER');
  requireThat(asset.chain !== 'stellar' || asset.code === 'XLM' || asset.issuer, 'ISSUER_REQUIRED');
  requireThat(asset.chain!=='stellar'||(asset.scale===7&&(asset.code!=='XLM'||!asset.issuer)),'INVALID_STELLAR_ASSET');
  requireThat(asset.chain!=='xrpl'||(asset.code==='XRP'&&!asset.issuer&&asset.scale===6),'ONLY_NATIVE_XRP_SUPPORTED');
  return [asset.chain, asset.network, asset.code, asset.issuer ?? 'native', asset.scale].join(':');
}
export function canonical(value: unknown): string {
  if(value===undefined)return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).filter(key=>(value as Record<string,unknown>)[key]!==undefined).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function uuid(value: unknown): string {
  requireThat(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), 'INVALID_ID');
  return value;
}
export const newId = randomUUID;
export type Source = { id: string; asset: Asset; available: string; adapter: string; accountId?: string; walletId?: string; address?:string; reason?: string };
// Rational rates are in integer source/recipient units. valuation converts source
// units to the quote's common cost unit. Fees include every source-side charge.
export type Route = { id: string; source: Source; capacity: string; numerator: string; denominator: string;
  fee: string; valuationNumerator: string; valuationDenominator: string; expiresAt: string; evidence: Record<string, unknown>; simulated?: boolean;
  networkFee?: {asset:Asset;amount:string;valuationNumerator:string;valuationDenominator:string;available:string} };
export type Allocation = { route: Route; receive: string; maxDebit: string };
export type FundingPlan = { allocations: Allocation[]; receive: string; cost: string; expiresAt: string; simulated: boolean };
export type Invoice = { id: string; owner: number; merchant: string; asset: Asset; amount: string; walletAddress?: string; incomingPayment?: string; expiresAt: string; reference: string };
export type Quote = FundingPlan & { id: string; owner: number; invoice: Invoice; rail: Record<string, unknown>; createdAt: string; hash: string };
export type Leg = Allocation & { id: string; state: 'planned' | 'prepared' | 'submitted' | 'confirmed' | 'failed' | 'unknown';
  prepared?: Record<string, unknown>; observation?: Observation; error?: string };
export type Observation = { state: 'pending' | 'confirmed' | 'failed' | 'unknown'; reference: string; received?: string; assetKey?: string; evidence?: Record<string, unknown> };
export type Execution = { id: string; owner: number; quote: Quote; state: 'funding' | 'ready' | 'paying' | 'paid' | 'recovery' | 'recovered';
  legs: Leg[]; outgoing?: Record<string, unknown>; receipt?: Record<string, unknown>; createdAt: string; error?: string };
export interface FundingAdapter {
  id: string;
  sources(owner: number): Promise<Source[]>;
  routes(source: Source, target: Asset, amount?: string): Promise<Route[]>;
  prepare(owner: number, execution: Execution, leg: Leg): Promise<Record<string, unknown>>;
  submit(owner: number, leg: Leg, signature: unknown): Promise<void>;
  observe(owner: number, leg: Leg): Promise<Observation>;
}
export interface PaymentRail {
  quote(invoice: Invoice): Promise<{ debit: string; expiresAt: string; data: Record<string, unknown> }>;
  prepare(execution: Execution): Promise<Record<string, unknown>>;
  observe(execution: Execution): Promise<Observation>;
}
