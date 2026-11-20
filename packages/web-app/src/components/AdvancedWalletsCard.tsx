import { useAdvancedWallets, MAX_WALLETS_PER_CHAIN } from "../lib/advanced-wallets";

/** Settings: extra Ethereum and XRP wallets are an advanced feature and stay off until a person turns them on. */
export default function AdvancedWalletsCard() {
  const [on, setOn] = useAdvancedWallets();
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-stellar-text">Advanced wallets</h3>
      <label className="flex min-h-11 items-start gap-3 text-sm text-stellar-text">
        <input type="checkbox" className="mt-1 h-5 w-5" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>Allow extra wallets
          <span className="block text-xs text-stellar-muted">
            Lets you hold up to {MAX_WALLETS_PER_CHAIN} wallets in total for Ethereum and {MAX_WALLETS_PER_CHAIN} for XRP, including your first. Most people only need one. Each XRP wallet needs its own reserve once funded. This setting starts off and is kept in this browser, for everyone who signs in on it.
          </span>
        </span>
      </label>
    </div>
  );
}
