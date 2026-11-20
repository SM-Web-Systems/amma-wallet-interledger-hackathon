import { useQuery } from "@tanstack/react-query";
import { activationFor, fetchActivation, type ActivationInfo } from "../lib/activation";

/**
 * Task-activation state for the wallet on screen. Quiet by design: when the server has activation off or the account is not
 * Amma-held, the call fails once and this returns null, so the screen looks exactly as it did before.
 */
export function useActivation(address: string | null, enabled = true): ActivationInfo | null {
  const { data } = useQuery({
    queryKey: ["custody-activation"],
    queryFn: fetchActivation,
    enabled: enabled && Boolean(address),
    retry: false,
    staleTime: 30_000,
    // Keep checking while the grant is on its way, so "Activating…" turns into "Active" without a reload.
    refetchInterval: (query) => (activationFor(query.state.data, address)?.state === "activating" ? 8_000 : false),
  });
  return activationFor(data, address);
}
