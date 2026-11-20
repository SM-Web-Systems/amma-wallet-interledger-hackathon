import { appLog } from "../../lib/app-log";
import { createPublicClient, createWalletClient, http, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { FundingAdapter } from "./service";

export class TreasuryLow extends Error { constructor() { super("treasury-low"); this.name = "TreasuryLow"; } }

/** The calls the drip needs; tests pass a mock. */
export interface SepoliaClients {
  treasury: `0x${string}`;
  getBalance(address: `0x${string}`): Promise<bigint>;
  sendTransaction(a: { to: `0x${string}`; value: bigint }): Promise<`0x${string}`>;
}

/** Format check only. The message never contains the key. */
export function assertTreasuryKey(key: string): asserts key is `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("WELCOME_SEPOLIA_TREASURY_KEY must be 0x followed by 64 hex characters.");
}

export function sepoliaClientsFromEnv(rpcUrl: string, key: string): SepoliaClients {
  assertTreasuryKey(key);
  const account = privateKeyToAccount(key, { nonceManager });
  const pub = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain: sepolia, transport: http(rpcUrl), account });
  return { treasury: account.address, getBalance: (address) => pub.getBalance({ address }), sendTransaction: (a) => wallet.sendTransaction({ ...a, account, chain: sepolia }) };
}

const eth = (wei: bigint) => `${(Number(wei / 1_000_000_000_000n) / 1_000_000).toFixed(4)} ETH`;

export function sepoliaDrip(clients: SepoliaClients, wei: bigint, warn: (msg: string) => void = (m) => appLog().warn({ detail: m }, "welcome_funding_warning")): FundingAdapter {
  return {
    chain: "evm",
    async fund(address) {
      const balance = await clients.getBalance(clients.treasury);
      if (balance < wei * 2n) throw new TreasuryLow();
      if (balance < wei * 20n) warn(`welcome_funding_treasury_low balance=${eth(balance)}`);
      const hash = await clients.sendTransaction({ to: address as `0x${string}`, value: wei });
      return { amount: eth(wei), reference: hash };
    },
  };
}
