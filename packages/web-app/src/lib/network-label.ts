/** The name shown to people for the network this site is connected to. */
export function networkLabel(network: string | undefined): "Mainnet" | "Testnet" {
  return network === "testnet" ? "Testnet" : "Mainnet";
}
