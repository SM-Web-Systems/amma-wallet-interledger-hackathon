# EVM engine: Ethereum foundation (sprint 1)

Status: Ethereum **Sepolia only**. Nothing here is wired into a client, enabled in production,
or deployed. Mainnet is present in the registry only so it can be refused by name.

## Scope of `packages/evm-core`
One TypeScript library for web, mobile and extension. It has no network I/O and no storage.
Each client supplies RPC reads and its own secure key storage.

| Module | Responsibility |
| --- | --- |
| `networks.ts` | Registry keyed by `networkId` (chain ID, native asset, confirmations, fee cap, enabled flag). `assertRpcChain` refuses an RPC reporting another chain. |
| `amounts.ts` | Exact decimal <-> bigint conversion. No floats, exponents or rounding. |
| `address.ts` | 20-byte addresses. Mixed case must pass EIP-55; the zero address is refused. |
| `fees.ts` | EIP-1559: `maxFee = 2 x baseFee + tip`, refused (not clamped) above the network cap. |
| `transfer.ts` | Plain ETH transfer (21000 gas, no calldata). Exact review totals; refuses when `value + max fee > balance`. |
| `signing.ts` | Signing boundary. Re-validates the prepared transaction against the user-approved intent (network, chain ID, sender, recipient, amount, gas, fee cap, totals) before using the key. Then recovers the signer from the signed bytes. |
| `cancel.ts` | User-approved cancel of a stuck transfer: same nonce, zero value to self, fee bump of at least 10%, its own signing boundary, intent read from the wallet's own signed bytes. |
| `lifecycle.ts` | Tracking: signed, broadcast, pending, included, confirmed, reverted, replaced, unknown. An unknown outcome only rebroadcasts the **same bytes**. A new nonce is refused while an earlier transfer is unresolved. |
| `derivation.ts` | BIP-39/BIP-44 `m/44'/60'/0'/0/i` (standard Ethereum path). |

Dependencies: `viem` 2.57.7 (serialization, signing, checksums) and `@scure/bip39` 1.6.0. Both are pinned; the runtime audit is clean.

## Platform signing boundaries (to implement per client)
- **Web:** key material is encrypted in IndexedDB like the XRP vault (PBKDF2-SHA256 600k, AES-256-GCM, bound to chain/network/address). It is decrypted only inside the signing call and dropped afterwards.
- **Mobile:** expo-secure-store, behind expo-local-authentication. The key is never exposed to JS longer than one signature.
- **Extension:** the key lives only in the service worker. Origin-bound approval window, strict message schema validation, and re-locking on worker suspension.

## Open decisions (owner/security review needed before mainnet)
1. **Recovery compatibility.** Existing Stellar wallets use SEP-0005 mnemonics (`m/44'/148'/x'`). Should the same mnemonic also derive EVM accounts on `m/44'/60'/0'/0/i`?
   - For: one backup covers both chains, and users can restore in MetaMask and other wallets.
   - Against: one secret now controls more chains.
   - XRP family seeds and raw Stellar secret keys are never reinterpreted as EVM keys.
2. **Manual recovery vs encrypted sync.** The current design assumes manual recovery only. No server-side secrets.
3. **RPC providers.** Pick a primary and a fallback Sepolia provider with separate non-production credentials. The client must call `assertRpcChain` on every provider.
4. **Asset evidence.** USDC/USDT on Ethereum need issuer evidence packs (contract identity, decimals). USDT also needs handling for its non-standard transfer return. Not in this sprint.

## Web client (sprint 1)
- `rpc.ts`: `EvmRpcReader`. It verifies `eth_chainId` per provider before trusting it and falls back across up to 3 https providers. Account reads are pinned to one block, and the transaction/receipt lookups parse strictly. A broadcast must return the locally computed hash.
- `packages/web-app/src/lib/evm/vault.ts`: an encrypted Sepolia vault in its own IndexedDB database, with the same KDF/cipher as the XRP vault. AAD binds the key format, path, owner, network and address. Each wallet gets a **new** mnemonic; reusing the Stellar mnemonic waits on decision 1.
- `/ethereum-sepolia` page: create/restore, balance, review (amount, max fee, max total), passphrase-approved signing, broadcast and tracking. Tracking rebroadcasts the same bytes while the state is unknown.
- Off unless `VITE_EVM_ENABLED=true`. Sending also needs `VITE_EVM_SEPOLIA_RPC_URLS`.
- Consumers install `@amma-wallet/evm-core` with `file:../evm-core` and `install-links=true`. A consumer must reinstall to pick up evm-core changes; CI does this on every run.
- Signed transfers are stored on the device (`amma-evm-transfers-v1`) before the first broadcast. After a reload,
  every unresolved one is tracked again and only its same bytes are rebroadcast. A new transfer is refused
  while any stored transfer from that wallet is unresolved.
- Stuck transfer: the user can approve a **cancel**, a zero-value transaction to self with the same nonce and
  both fee fields raised by at least 10% (or to the market rate, if that is higher). Only one transaction for
  a nonce can be included, so a cancel cannot pay twice. Once a cancel exists, the original is no longer
  rebroadcast. There is one cancel per nonce, and speed-up is not built.

## Next steps
1. Backend: an `evm` chain value in the chain-storage model and public wallet registration, behind `EVM_ENABLED=false`, with a guarded migration.
2. Persist tracked transfers (IndexedDB) across reloads.
3. Extension and mobile integration.
4. Testnet acceptance: send/receive, nonce races across two devices, a provider that lies about the chain ID, replaced/reverted/dropped handling.
