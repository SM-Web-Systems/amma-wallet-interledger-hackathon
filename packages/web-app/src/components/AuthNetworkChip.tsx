import { useTranslation } from "react-i18next";

/**
 * Marks signed-out pages (login, register, forgot and reset password) on a test-network build, so nobody
 * signs up for a real wallet or types a real password here by mistake. Shows nothing on mainnet.
 * Fixed in the corner, so it never moves the page.
 */
export default function AuthNetworkChip() {
  const { t } = useTranslation();
  // The build decides (VITE_DEFAULT_NETWORK, same flag the wallet store starts from), so a signed-out page never depends on wallet state.
  if (import.meta.env.VITE_DEFAULT_NETWORK !== "testnet") return null;
  return (
    <span
      role="status"
      data-testid="auth-network-chip"
      className="pointer-events-none fixed top-3 right-3 z-10 inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-amber-500/20 text-amber-700 dark:text-amber-300 font-medium"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      {t("auth.testnetChip")}
      <span className="sr-only"> - {t("auth.testnetChipSr")}</span>
      <span aria-hidden="true"> &middot; {t("auth.testnetChipNote")}</span>
    </span>
  );
}
