// The widget environment is clamped: a testnet deployment can only ever open the staging widget (D-02).
export type TransakEnvironment = "STAGING" | "PRODUCTION";

export function transakEnvironment(network: string | undefined, configured: string | undefined): TransakEnvironment {
  if (network !== "public") return "STAGING";
  return configured === "PRODUCTION" ? "PRODUCTION" : "STAGING";
}
