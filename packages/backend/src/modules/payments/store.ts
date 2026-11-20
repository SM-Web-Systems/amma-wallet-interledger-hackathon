import { newId, assetKey, canonical, requireThat, units, type Asset } from './domain';
export interface Session { query<T = Record<string, any>>(text: string, params?: any[]): Promise<T[]> }
export interface Database extends Session { transaction<T>(fn: (tx: Session) => Promise<T>): Promise<T> }
export class PaymentStore {
  constructor(public db: Database) {}
  async get<T>(tx: Session, kind: string, id: string, owner?: number, lock = false): Promise<T> {
    const rows = await tx.query(`SELECT body FROM payment_documents WHERE kind=$1 AND id=$2 ${owner === undefined ? '' : 'AND owner_id=$3'} ${lock ? 'FOR UPDATE' : ''}`,
      owner === undefined ? [kind,id] : [kind,id,owner]);
    requireThat(rows[0], 'PAYMENT_NOT_FOUND', 404); return rows[0].body;
  }
  async put(tx: Session, kind: string, id: string, owner: number, body: unknown) {
    await tx.query(`INSERT INTO payment_documents(kind,id,owner_id,body) VALUES($1,$2,$3,$4::text::jsonb)
      ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,version=payment_documents.version+1`,[kind,id,owner,canonical(body)]);
  }
  async account(tx: Session, owner: number, asset: Asset, kind = 'customer', reference = 'main'): Promise<string> {
    const rows = await tx.query(`INSERT INTO payment_accounts(id,owner_id,asset_key,asset,kind,reference) VALUES($1,$2,$3,$4::text::jsonb,$5,$6)
      ON CONFLICT(owner_id,asset_key,kind,reference) DO UPDATE SET reference=excluded.reference RETURNING id`,[newId(),owner,assetKey(asset),canonical(asset),kind,reference]);
    return rows[0].id;
  }
  async transfer(tx: Session, from: string, to: string, asset: Asset, amount: string, reference: string) {
    units(amount); requireThat(from !== to, 'SAME_LEDGER_ACCOUNT');
    const prior = await tx.query('SELECT * FROM payment_ledger WHERE reference=$1',[reference]);
    if (prior.length) {
      requireThat(prior[0].debit_account===from && prior[0].credit_account===to && prior[0].amount===amount && prior[0].asset_key===assetKey(asset),'LEDGER_REFERENCE_CONFLICT',409);
      return;
    }
    // Deterministic lock ordering avoids deadlocks between opposite transfers.
    await tx.query('SELECT id FROM payment_accounts WHERE id IN ($1,$2) ORDER BY id FOR UPDATE',[from,to]);
    const debited = await tx.query(`UPDATE payment_accounts SET balance=balance-$1::numeric WHERE id=$2 AND asset_key=$3
      AND (kind IN ('clearing','fees') OR balance >= $1::numeric) RETURNING id`,[amount,from,assetKey(asset)]);
    requireThat(debited.length, 'INSUFFICIENT_AVAILABLE_BALANCE',409);
    const credited=await tx.query('UPDATE payment_accounts SET balance=balance+$1::numeric WHERE id=$2 AND asset_key=$3 RETURNING id',[amount,to,assetKey(asset)]);
    requireThat(credited.length,'LEDGER_ASSET_MISMATCH');
    await tx.query('INSERT INTO payment_ledger(id,reference,asset_key,debit_account,credit_account,amount) VALUES($1,$2,$3,$4,$5,$6)',[newId(),reference,assetKey(asset),from,to,amount]);
  }
  async balances(owner: number) { return this.db.query(`SELECT id,asset,balance::text AS available FROM payment_accounts WHERE owner_id=$1 AND kind='customer' ORDER BY asset_key`,[owner]); }
  async enqueue(tx: Session, id: string, owner: number, kind: string, body: unknown) {
    await tx.query('INSERT INTO payment_jobs(id,owner_id,kind,body) VALUES($1,$2,$3,$4::text::jsonb) ON CONFLICT DO NOTHING',[id,owner,kind,canonical(body)]);
  }
}
