import { useEffect } from "react";
import { getEvmAlerts, getEvmConfig, markEvmAlertsSeen } from "../lib/eth-server-data";
import { useNotificationStore } from "../store/notifications";
import { evmEnabled } from "../lib/evm/feature";
import { mainnetCustodyBuild } from "../lib/custody-network";

const EVERY_MS = 60_000;

/**
 * Turns the server's unread incoming-payment alerts (ETH_ALERTS on there) into bell notifications.
 * The text never names a sender: anyone can send dust from a look-alike address, and a shortened address is exactly what that trick relies on.
 * Renders nothing; asks the server once whether alerts are on and does nothing when they are not (or the server is older).
 */
export default function EthAlertsPoller() {
  const add = useNotificationStore((s) => s.addNotification);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stored = new Set<string>();
    const poll = async () => {
      try {
        const fresh = (await getEvmAlerts()).filter((a) => !stored.has(a.id));
        for (const a of fresh) {
          if (!live) return;
          add({ type: "success", title: "Payment received", message: `You received ${a.value} ${a.asset}${mainnetCustodyBuild() ? "" : " on the Sepolia test network"}.`, ...(evmEnabled ? { link: "/ethereum-sepolia" } : {}) });
          stored.add(a.id);
        }
        // Only after they are stored here: if this fails, the server sends them again and `stored` stops a double notification.
        if (fresh.length) await markEvmAlertsSeen(fresh.map((a) => a.id));
      } catch { /* the next tick retries */ }
    };
    getEvmConfig().then((c) => { if (live && c?.alerts === true) { void poll(); timer = setInterval(() => void poll(), EVERY_MS); } }).catch(() => undefined);
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [add]);
  return null;
}
