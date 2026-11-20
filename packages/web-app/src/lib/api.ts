import { API_BASE } from "./constants";
import type { PaymentInput, PaymentIntent, PaymentReceipt } from "./xrpl/payment";

// ——— Token store for auth ———
// The access token lives in memory only and is never persisted to browser storage.
// The refresh token is held by the server in an httpOnly cookie that scripts cannot
// read, so a page reload restores the session through POST /auth/refresh.
let _accessToken: string | null = null;

// The refresh token argument is ignored: the server also sets it as the httpOnly cookie.
export function setTokens(access: string, _refresh?: string) {
  _accessToken = access;
}

export function clearTokens() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("amma:xrpl:lock"));
  _accessToken = null;
}

export function getAccessToken() {
  return _accessToken;
}

// ——— Base request with auto-refresh ———
export async function request<T>(path: string, options?: RequestInit & { auth?: boolean }): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };

  if (options?.auth !== false && _accessToken) {
    headers["Authorization"] = `Bearer ${_accessToken}`;
  }

  // Auth routes set or read the httpOnly refresh cookie. The API is on another origin
  // (api.ammawallet.com), so the browser only keeps and sends it with credentials.
  if (path.startsWith("/api/v1/auth/")) options = { ...options, credentials: "include" };

  let res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401 && options?.auth !== false) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      headers["Authorization"] = `Bearer ${_accessToken}`;
      res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    // The error code stays on the error, so screens can explain it (see paymentErrorText).
    // status and unreadable (not JSON, e.g. a proxy's HTML page) let a money screen tell "may have applied" from a refusal.
    throw Object.assign(
      new Error(typeof body?.error === "string" ? body.error : body?.error?.message || `API error ${res.status}`),
      {
        code: (typeof body?.code === "string" ? body.code : body?.error?.code) as string | undefined,
        status: res.status,
        // When a locked sign-in opens again (ISO), so the login page can say so.
        retryAt: typeof body?.retryAt === "string" ? body.retryAt : undefined,
        unreadable: body === null || typeof body !== "object",
      },
    );
  }
  return res.json();
}

// Each refresh rotates the cookie and revokes the old token, so concurrent callers
// must share one request: a second parallel refresh would present a revoked token.
let _refreshInFlight: Promise<boolean> | null = null;

function tryRefresh(): Promise<boolean> {
  _refreshInFlight ??= refreshOneTabAtATime().finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}

// Tabs share the cookie but not this module, so they take turns through a browser lock.
// Each then presents the newest cookie, set by the tab before it.
async function refreshOneTabAtATime(): Promise<boolean> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? await locks.request("amma-auth-refresh", refreshFromCookie) : refreshFromCookie();
}

/** Restore the session from the httpOnly refresh cookie, e.g. after a page reload. */
export function restoreSession(): Promise<boolean> {
  return tryRefresh();
}

async function refreshFromCookie(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Amma-Refresh": "1" },
      body: "{}",
    });
    if (!res.ok) {
      clearTokens();
      return false;
    }
    const data = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    clearTokens();
    return false;
  }
}

// ——— Auth ———
export const authApi = {
  register: (data: { email: string; password: string; firstName?: string; lastName?: string; turnstileToken?: string }) =>
    request<any>("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
      auth: false,
    } as any),

  login: (data: { email?: string; phoneNumber?: string; password: string; turnstileToken?: string; twoFaToken?: string }) =>
    request<any>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
      auth: false,
    } as any),

  me: () => request<any>("/api/v1/auth/me"),
  addEmail: (data: {email: string; currentPassword: string}) => request<{success: boolean; verificationSent: boolean; message: string}>(
    '/api/v1/auth/email', {method: 'POST', body: JSON.stringify(data)}),
  resendVerification: () => request<{success: boolean; message: string}>('/api/v1/auth/resend-verification', {
    method: 'POST', body: JSON.stringify({}),
  }),

  updateProfile: (data: { firstName?: string; lastName?: string; preferredLanguage?: string; preferredNetwork?: string }) =>
    request<any>("/api/v1/auth/profile", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    request<any>("/api/v1/auth/change-password", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  logout: () =>
    request<any>("/api/v1/auth/logout", {
      method: "POST",
      body: "{}", // the server revokes the token in the refresh cookie and clears it
    }).finally(() => clearTokens()),
};

// ——— User Wallets (server-side) ———
export const userWalletApi = {
  list: () => request<any[]>("/api/v1/wallets"),

  add: (data: { name: string; publicKey: string; encryptedSecret?: string; network?: string }) =>
    request<any>("/api/v1/wallets", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  activate: (id: number) => request<any>(`/api/v1/wallets/${id}/activate`, { method: "PATCH", body: JSON.stringify({}) }),
  rename: (id: number, name: string) => request<any>(`/api/v1/wallets/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  /** Replace the server copy of the encrypted key after a passphrase change. */
  /** Self-custody: remove the server's encrypted copy of this wallet's key (D1b). */
  /** Managed wallet: get back Amma's stored copy of this wallet's key. It is encrypted with the passphrase the wallet was made with. */
  getKeyBackup: (id: number) => request<{ encryptedSecret: string }>(`/api/v1/wallets/${id}/secret`),
  removeSecret: (id: number) => request<{ ok: boolean }>(`/api/v1/wallets/${id}/secret`, { method: "DELETE" }),
  updateSecret: (id: number, encryptedSecret: string) =>
    request<{ ok: boolean }>(`/api/v1/wallets/${id}/secret`, { method: "PATCH", body: JSON.stringify({ encryptedSecret }) }),
  /** Delegated signing: the server re-encrypts the active wallet (the browser holds no ciphertext). */
  changeDelegatedPassphrase: (currentPin: string, newPassphrase: string) =>
    request<{ ok: boolean }>("/api/v1/wallets/active/passphrase", { method: "POST", body: JSON.stringify({ currentPin, newPassphrase }) }),
  remove: (id: number) => request<any>(`/api/v1/wallets/${id}`, { method: "DELETE" }),
};

// ——— Managed wallet: Amma's sealed backup of the recovery phrase ———
export const keyEscrowApi = {
  status: () => request<{ enabled: boolean; hasPhrase: boolean }>("/api/v1/key-escrow/status"),
  /** The phrase goes over TLS and is sealed on arrival. Never log or keep it. */
  savePhrase: (phrase: string) => request<{ saved: boolean }>("/api/v1/key-escrow/phrase", { method: "PUT", body: JSON.stringify({ phrase }) }),
  /** Reading it back needs the account password again. */
  /** Returns the phrase, or { twoFaRequired } first for users with two-factor sign-in (send again with twoFaToken). */
  openPhrase: (password: string, twoFaToken?: string) => request<{ phrase: string } | { twoFaRequired: true; twoFaMethod: string }>("/api/v1/key-escrow/phrase/open", { method: "POST", body: JSON.stringify(twoFaToken ? { password, twoFaToken } : { password }) }),
};

export type RecoveryStatus = { enabled: boolean; state: "none" | "waiting" | "ready"; readyAt?: string };
/** Managed wallet: recover the wallet's recovery phrase after forgetting the passphrase (a waiting period applies). */
export const keyRecoveryApi = {
  status: () => request<RecoveryStatus>("/api/v1/key-recovery/status"),
  sendCode: () => request<{ sent: boolean }>("/api/v1/key-recovery/code", { method: "POST", body: JSON.stringify({}) }),
  start: (password: string, code: string) =>
    request<{ state: "waiting"; readyAt: string }>("/api/v1/key-recovery/request", { method: "POST", body: JSON.stringify({ password, code }) }),
  cancel: () => request<{ cancelled: boolean }>("/api/v1/key-recovery/cancel", { method: "POST", body: JSON.stringify({}) }),
  /** The link in the alert email. No sign-in needed. */
  cancelByToken: (token: string) =>
    request<{ cancelled: boolean }>("/api/v1/key-recovery/cancel-by-token", { method: "POST", auth: false, body: JSON.stringify({ token }) }),
  /** Works once, after the wait. The phrase must be kept or used straight away. */
  complete: (password: string) => request<{ phrase: string }>("/api/v1/key-recovery/complete", { method: "POST", body: JSON.stringify({ password }) }),
};

// ——— Tokens ———
export const tokenApi = {
  featured: () => request<any[]>("/api/v1/tokens/featured"),
  search: (query: string, sortBy = "rating", limit = 50) =>
    request<any[]>(`/api/v1/tokens?query=${encodeURIComponent(query)}&sortBy=${sortBy}&limit=${limit}`),
  list: (params: { sortBy?: string; limit?: number; offset?: number; query?: string; verified?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (params.query) p.set("query", params.query);
    if (params.sortBy) p.set("sortBy", params.sortBy);
    if (params.limit) p.set("limit", String(params.limit));
    if (params.offset) p.set("offset", String(params.offset));
    if (params.verified) p.set("verified", "true");
    return request<{ tokens: any[]; pagination: { total: number; limit: number; offset: number; hasMore: boolean } }>(`/api/v1/tokens?${p.toString()}`);
  },
  priceHistory: (code: string, issuer: string, resolution = "86400000", limit = 30) =>
    request<{ candles: Array<{ timestamp: number; open: string; high: string; low: string; close: string; volume: string; tradeCount: number }>; resolution: string; baseAsset: string; counterAsset: string }>(
      `/api/v1/tokens/${encodeURIComponent(code)}/${encodeURIComponent(issuer)}/price-history?resolution=${resolution}&limit=${limit}`
    ),
  detail: (code: string, issuer: string) =>
    request<any>(`/api/v1/tokens/${encodeURIComponent(code)}/${encodeURIComponent(issuer)}`),
  userTokens: (publicKey: string) =>
    request<any[]>(`/api/v1/tokens/user/${publicKey}`),
  toggleFavorite: (publicKey: string, code: string, issuer: string) =>
    request<any>("/api/v1/tokens/favorite", {
      method: "POST",
      body: JSON.stringify({ publicKey, assetCode: code, assetIssuer: issuer }),
    }),
  searchAssets: (query: string, limit = 20) =>
    request<any>(`/api/v1/tokens/search-assets?query=${encodeURIComponent(query)}&limit=${limit}`),
};

// ——— Swap ———
export const swapApi = {
  quote: (params: { fromCode: string; fromIssuer: string; toCode: string; toIssuer: string; amount: string }) =>
    request<any[]>(`/api/v1/swap/quote?fromCode=${params.fromCode}&fromIssuer=${params.fromIssuer}&toCode=${params.toCode}&toIssuer=${params.toIssuer}&amount=${params.amount}`),
  build: (params: any) =>
    request<{ xdr: string; networkPassphrase: string }>("/api/v1/swap/build", {
      method: "POST",
      body: JSON.stringify(params),
    }),
};

// ——— Wallet (legacy Horizon helpers) ———
export const walletApi = {
  account: (publicKey: string) => request<any>(`/api/v1/wallet/${publicKey}`),
  fund: (publicKey: string) =>
    request<any>("/api/v1/wallet/fund", { method: "POST", body: JSON.stringify({ publicKey }) }),
};

// ——— Transactions ———
export const txApi = {
  submit: (signedXdr: string) =>
    request<any>("/api/v1/transactions/submit", {
      method: "POST",
      body: JSON.stringify({ signedXdr }),
    }),
  history: (publicKey: string, limit = 20, cursor?: string) =>
    request<any[]>(
      `/api/v1/transactions/${publicKey}?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`
    ),
};

// ——— Signing Mode (Delegated) ———
export const signingApi = {
  getMode: () =>
    request<{ signingMode: string }>("/api/v1/user/signing-mode").then(
      (data) => data.signingMode as "self" | "delegated"
    ),

  setMode: (mode: "self" | "delegated") =>
    request<any>("/api/v1/user/signing-mode", {
      method: "PATCH",
      body: JSON.stringify({ mode }),
    }),

  sign: (xdr: string, networkPassphrase: string) =>
    request<{ signedXdr: string; networkPassphrase: string }>("/api/v1/transactions/sign", {
      method: "POST",
      body: JSON.stringify({ xdr, networkPassphrase }),
    }),

  /**
   * `secret` is the wallet passphrase/PIN, or the account password for Amma-held (custody) wallets.
   * `expectedHash`: the fee quote's innerHash; the server refuses (409 fee_changed) rather than submit a different transaction.
   */
  signAndSubmit: (xdr: string, networkPassphrase: string, secret?: string, kind: "pin" | "password" = "pin", expectedHash?: string) =>
    request<any>("/api/v1/transactions/sign-and-submit", {
      method: "POST",
      body: JSON.stringify({ xdr, networkPassphrase, [kind]: secret, ...(expectedHash ? { expectedHash } : {}) }),
    }),

  /** Read only: the Amma fee the server will add to this unsigned XDR, what the user pays in total, and the hash it will submit. */
  feeQuote: (xdr: string) =>
    request<FeeQuote>("/api/v1/transactions/fee-quote", {
      method: "POST",
      body: JSON.stringify({ xdr }),
    }),
};

export interface FeeQuote {
  innerHash: string;
  fee: { feePercent: number; minFeeXlm: number; feeOperations: { asset: string; amount: string; xlmFallbackFor?: string[] }[]; xlmFallback?: string[] } | null;
  pays: { asset: string; issuer?: string; amount: string; upTo: boolean }[];
  networkFeePaidByAmma: boolean;
}

// ——— API Keys ———
export const apiKeyApi = {
  create: (name: string) =>
    request<{ id: number; name: string; key: string; createdAt: string; message: string }>(
      "/api/v1/api-keys",
      {
        method: "POST",
        body: JSON.stringify({ name }),
      }
    ),

  list: () =>
    request<
      {
        id: number;
        name: string;
        keyPreview: string;
        isActive: boolean;
        lastUsedAt: string | null;
        createdAt: string;
      }[]
    >("/api/v1/api-keys"),

  revoke: (id: number) =>
    request<{ success: boolean; message: string }>(`/api/v1/api-keys/${id}`, {
      method: "DELETE",
    }),
};

// ——— Keypair ———
export const keypairApi = {
  generate: () => request<{ publicKey: string; secretKey: string }>("/api/v1/keypair/generate"),
  // validateMnemonic and fromMnemonic removed (P0-3-F2)
  // HD derivation now happens client-side in lib/hd-wallet.ts
};

// ——— Trustlines ———
export const trustlineApi = {
  list: (publicKey: string) =>
    request<any>(`/api/v1/trustlines/${publicKey}`),
  check: (publicKey: string, code: string, issuer: string) =>
    request<any>(`/api/v1/trustlines/check/${publicKey}/${code}/${issuer}`),
  add: (publicKey: string, code: string, issuer: string) =>
    request<any>("/api/v1/trustlines/add", {
      method: "POST",
      body: JSON.stringify({ publicKey, assetCode: code, assetIssuer: issuer }),
    }),
  remove: (publicKey: string, code: string, issuer: string) =>
    request<any>("/api/v1/trustlines/remove", {
      method: "POST",
      body: JSON.stringify({ publicKey, assetCode: code, assetIssuer: issuer }),
    }),
};

// ——— 2FA ———
export const twoFaApi = {
  status: () =>
    request<{ enabled: boolean; method: string }>("/api/v1/auth/2fa/status"),

  setup: (method: "totp" | "email" | "static" = "totp", staticCode?: string) =>
    request<any>("/api/v1/auth/2fa/setup", {
      method: "POST",
      body: JSON.stringify({ method, staticCode }),
    }),

  verify: (token: string) =>
    request<{ success: boolean; backupCodes: string[]; message: string }>("/api/v1/auth/2fa/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

  disable: (token: string, password: string) =>
    request<{ success: boolean; message: string }>("/api/v1/auth/2fa/disable", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    }),

  sendEmailCode: (email?: string) =>
    email
      ? request<{ success: boolean }>("/api/v1/auth/2fa/send-email-code", {
          method: "POST",
          body: JSON.stringify({ email }),
        })
      : request<{ success: boolean }>("/api/v1/auth/2fa/send-code", {
          method: "POST",
          body: JSON.stringify({}),
        }),
};

export const contactsApi = {
  list: () => request<any[]>("/api/v1/contacts"),
  add: (data: { name: string; address: string; memo?: string; memoType?: string; notes?: string }) =>
    request<any>("/api/v1/contacts", { method: "POST", body: JSON.stringify(data) }),
  update: (id: number, data: { name?: string; memo?: string; memoType?: string; notes?: string }) =>
    request<any>("/api/v1/contacts/" + id, { method: "PATCH", body: JSON.stringify(data) }),
  remove: (id: number) =>
    request<any>("/api/v1/contacts/" + id, { method: "DELETE" }),
};

export const fiatApi = {
  transakUrl: (b: { walletAddress: string; fiatCurrency: string; fiatAmount?: number; type: "buy" | "sell" }) =>
    request<{ url: string }>("/api/v1/fiat/transak/url", { method: "POST", body: JSON.stringify(b) }),
  currencies: () => request<any>("/api/v1/fiat/currencies"),
  buyQuote: (fiatCurrency: string, fiatAmount: number, targetAsset = "XLM") =>
    request<any>("/api/v1/fiat/quote/buy", {
      method: "POST",
      body: JSON.stringify({ fiatCurrency, fiatAmount, targetAsset }),
    }),
  sellQuote: (fiatCurrency: string, cryptoAmount: number, sourceAsset = "XLM") =>
    request<any>("/api/v1/fiat/quote/sell", {
      method: "POST",
      body: JSON.stringify({ fiatCurrency, cryptoAmount, sourceAsset }),
    }),
  buy: (quoteId: string, paymentMethod: string, destinationAddress: string) =>
    request<any>("/api/v1/fiat/buy", {
      method: "POST",
      body: JSON.stringify({ quoteId, paymentMethod, destinationAddress }),
    }),
  sell: (quoteId: string, bankDetails?: any) =>
    request<any>("/api/v1/fiat/sell", {
      method: "POST",
      body: JSON.stringify({ quoteId, bankDetails }),
    }),
};

export const portfolioApi = {
  snapshot: () => request<any>("/api/v1/portfolio/snapshot", { method: "POST" }),
  history: (days = 30) => request<any>("/api/v1/portfolio/history?days=" + days),
  summary: () => request<any>("/api/v1/portfolio/summary"),
};

export const moneygramApi = {
  info: () => request<any>("/api/v1/moneygram/info"),
  deposit: (publicKey: string, amount?: string) =>
    request<any>("/api/v1/moneygram/deposit", {
      method: "POST",
      body: JSON.stringify({ publicKey, amount }),
    }),
  withdraw: (publicKey: string, amount?: string) =>
    request<any>("/api/v1/moneygram/withdraw", {
      method: "POST",
      body: JSON.stringify({ publicKey, amount }),
    }),
  transactionStatus: (id: string, publicKey: string) =>
    request<any>(`/api/v1/moneygram/transaction/${id}?publicKey=${publicKey}`),
};

export const earnApi = {
  pools: (asset?: string, limit = 20) =>
    request<any>(`/api/v1/earn/pools?${asset ? "asset=" + asset + "&" : ""}limit=${limit}`),
  positions: (publicKey: string) =>
    request<any>(`/api/v1/earn/positions/${publicKey}`),
  deposit: (publicKey: string, poolId: string, maxAmountA: string, maxAmountB: string) =>
    request<any>("/api/v1/earn/deposit", {
      method: "POST",
      body: JSON.stringify({ publicKey, poolId, maxAmountA, maxAmountB }),
    }),
  withdraw: (publicKey: string, poolId: string, shares: string) =>
    request<any>("/api/v1/earn/withdraw", {
      method: "POST",
      body: JSON.stringify({ publicKey, poolId, shares }),
    }),
};


// ─── NFTs (SEP-50 Soroban + SEP-39 Classic) ───────────────
export const nftApi = {
  collections: (limit = 50, offset = 0, network?: string) => {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (network) qs.set("network", network);
    return request<{ collections: any[]; total: number }>(`/api/v1/nfts/collections?${qs}`);
  },
  collection: (id: number) => request<any>(`/api/v1/nfts/collections/${id}`),
  tokensByOwner: (publicKey: string, includeClassicScan = false, limit = 50, offset = 0) => {
    const qs = new URLSearchParams({
      limit: String(limit), offset: String(offset),
      includeClassicScan: String(includeClassicScan),
    });
    return request<{ indexed: { tokens: any[]; total: number }; classicNfts: any[] }>(
      `/api/v1/nfts/owner/${publicKey}?${qs}`
    );
  },
  classicScan: (publicKey: string) => request<any[]>(`/api/v1/nfts/classic/${publicKey}`),
  transfer: (body: { contractId: string; fromAddress: string; toAddress: string; tokenId: number }) =>
    request<{ xdr: string; networkPassphrase: string }>(
      "/api/v1/nfts/transfer", { method: "POST", body: JSON.stringify(body) }
    ),
};

// XRP onboarding sends public metadata only; no seed, vault blob or passphrase.
export interface XrpServerWallet {
  id: string; ownerId: string; name: string; address: string;
  chain: "xrpl"; network: "testnet"; custody: "self"; isActive: boolean;
}
export interface XrpAccountSnapshot {
  address: string; funded: boolean; balanceDrops: string; reserveDrops: string; spendableDrops: string;
  validatedLedgerIndex: number; validatedLedgerHash: string;
}
export const xrplWalletApi = {
  list: () => request<XrpServerWallet[]>("/api/v1/xrpl/wallets"),
  register: (wallet: { name: string; address: string }) => request<XrpServerWallet>("/api/v1/xrpl/wallets", { method: "POST", body: JSON.stringify({ name: wallet.name, address: wallet.address }) }),
  activate: (id: string) => request<XrpServerWallet>(`/api/v1/xrpl/wallets/${encodeURIComponent(id)}/activate`, { method: "PATCH", body: "{}" }),
  account: (id: string) => request<XrpAccountSnapshot>(`/api/v1/xrpl/wallets/${encodeURIComponent(id)}/account`),
};

const paymentBase = "/api/v1/xrpl/payment-intents";
export const xrplPaymentApi = {
  availability:()=>request<{chain:"xrpl";network:"testnet";available:boolean;code:string}>("/api/v1/xrpl/payment-availability"),
  list: (walletId: string) => request<PaymentIntent[]>(`${paymentBase}?walletId=${encodeURIComponent(walletId)}`),
  create: (input: PaymentInput, idempotencyKey: string) => request<PaymentIntent>(paymentBase,{method:"POST",headers:{"Idempotency-Key":idempotencyKey},body:JSON.stringify({
    schemaVersion:1,walletId:input.walletId,chain:"xrpl",network:"testnet",destination:input.destination,
    ...(input.destinationTag === undefined ? {} : {destinationTag:input.destinationTag}),amountDrops:input.amountDrops,maxFeeDrops:input.maxFeeDrops,reference:input.reference,
  })}),
  prepare: (id: string) => request<PaymentIntent>(`${paymentBase}/${encodeURIComponent(id)}/prepare`,{method:"POST",body:"{}"}),
  submit: (id: string, preparationId: string, blob: string) => request<PaymentIntent>(`${paymentBase}/${encodeURIComponent(id)}/submit`,{method:"POST",body:JSON.stringify({preparationId,blob})}),
  status: (id: string) => request<PaymentIntent>(`${paymentBase}/${encodeURIComponent(id)}`),
  rebroadcast: (id: string) => request<PaymentIntent>(`${paymentBase}/${encodeURIComponent(id)}/rebroadcast`,{method:"POST",body:"{}"}),
  receipt: (id: string) => request<PaymentReceipt>(`${paymentBase}/${encodeURIComponent(id)}/receipt`),
  cancel: (id: string) => request<PaymentIntent>(`${paymentBase}/${encodeURIComponent(id)}/cancel`,{method:"POST",body:"{}"}),
};
