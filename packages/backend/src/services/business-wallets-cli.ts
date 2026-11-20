/**
 * Operator commands for business wallets and the fee address pool. Prints public addresses only, never a key.
 *
 *   npm run business-wallets -- create --tenant=1 --network=testnet --by=NAME
 *   npm run business-wallets -- add-fee-addresses --network=public --by=NAME G... G...
 *   npm run business-wallets -- assign-fee-address --tenant=1 --network=public --by=NAME [--address=G...]
 *   npm run business-wallets -- show --tenant=1 --network=testnet
 *
 * Making a business wallet on the public network also needs --mainnet-approved (the owner's typed go).
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { resolveDatabaseUrl } from "../lib/docker-secrets";
import { masterKeyProviderFromEnv } from "../lib/key-wrapper";
import { rowsOf } from "../modules/activation/errors";
import { addFeeAddresses, assignFeeAddress, businessWalletAddress, createBusinessWallet, type StellarNetwork } from "./business-wallets";

// Command output is plain JSON on stdout (public addresses and counts only); errors go to stderr.
const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");

export function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const options: Record<string, string> = {};
  const positional: string[] = [];
  for (const arg of rest) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (m) options[m[1]] = m[2] ?? "true"; else positional.push(arg);
  }
  const tenant = () => { const n = Number(options.tenant); if (!Number.isInteger(n) || n < 1) throw new Error("--tenant=ID is required"); return n; };
  const network = (): StellarNetwork => { if (options.network !== "testnet" && options.network !== "public") throw new Error("--network=testnet|public is required"); return options.network; };
  const by = () => { if (!options.by) throw new Error("--by=NAME is required"); return options.by; };
  return { command, options, positional, tenant, network, by };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = postgres(resolveDatabaseUrl(), { max: 1, connect_timeout: 10, onnotice: () => {} });
  const db = drizzle(client) as any;
  try {
    switch (args.command) {
      case "create": {
        const network = args.network();
        if (network === "public" && args.options["mainnet-approved"] !== "true") throw new Error("A public-network business wallet needs --mainnet-approved (the owner's typed go)");
        const provider = masterKeyProviderFromEnv();
        if (!provider) throw new Error("KEY_WRAP_PROVIDER is not set; a business wallet key cannot be sealed");
        const r = await createBusinessWallet(db, provider, { tenantId: args.tenant(), network, createdBy: args.by() });
        out({ address: r.address, created: r.created });
        break;
      }
      case "add-fee-addresses": {
        out(await addFeeAddresses(db, { network: args.network(), addresses: args.positional, addedBy: args.by() }));
        break;
      }
      case "assign-fee-address": {
        const r = await assignFeeAddress(db, { tenantId: args.tenant(), network: args.network(), now: new Date(), address: args.options.address, by: args.by() });
        out(r);
        break;
      }
      case "show": {
        const tenantId = args.tenant(); const network = args.network();
        const fee = rowsOf<{ address: string }>(await db.execute(sql`SELECT address FROM fee_address_pool WHERE tenant_id = ${tenantId} AND network = ${network}`))[0]?.address ?? null;
        out({ wallet: await businessWalletAddress(db, tenantId, network), feeAddress: fee });
        break;
      }
      default:
        throw new Error("Commands: create, add-fee-addresses, assign-fee-address, show");
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (require.main === module) {
  // Only our own messages are printed: a database or provider error could carry a connection string.
  main().catch((e) => { process.stderr.write(`${e instanceof Error && !/postgres(ql)?:\/\//i.test(e.message) ? e.message : "Command failed"}\n`); process.exitCode = 1; });
}
