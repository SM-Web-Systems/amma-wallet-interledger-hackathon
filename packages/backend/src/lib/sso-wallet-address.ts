/**
 * The mainnet Stellar address sent to a partner (the LMS) at SSO sign-in.
 * Prefer the Amma-held wallet (derivation index 0): that is the address task activation funds and the one a partner
 * should mint to. Without one, keep the earlier behaviour: the newest active wallet.
 */
export interface SsoWalletRow { publicKey: string; isActive: boolean | null; derivationIndex: number | null; createdAt: Date | string | null }

export function pickSsoWalletAddress(rows: SsoWalletRow[]): string | null {
  const held = rows.find((r) => r.derivationIndex === 0);
  if (held) return held.publicKey;
  const time = (r: SsoWalletRow) => (r.createdAt ? new Date(r.createdAt).getTime() : 0);
  const active = rows.filter((r) => r.isActive === true).sort((a, b) => time(b) - time(a));
  return active[0]?.publicKey ?? null;
}
