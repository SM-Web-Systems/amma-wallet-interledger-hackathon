import { NETWORK_LOCK, networkBadgeText } from "../lib/network-lock";

// Always visible on a testnet build, so nobody mistakes test money for real money.
export default function NetworkBadge() {
  const text = networkBadgeText(NETWORK_LOCK);
  if (!text) return null;
  return (
    <div role="status" className="bg-amber-500/20 border-b border-amber-500/30 text-amber-300 text-[10px] font-medium text-center py-0.5">
      {text}
    </div>
  );
}
