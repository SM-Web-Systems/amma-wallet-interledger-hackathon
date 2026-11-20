import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import type { BalanceViewState } from "../../lib/balance-view";
import type { ActivationState } from "../../lib/activation";

export type BalanceStateLabels = {
  loadFailed: ReactNode;
  loadFailedHint: ReactNode;
  retry: ReactNode;
  stale: ReactNode;
  empty: ReactNode;
  receive: ReactNode;
  /** Name for the spinner, read out while loading. */
  loading?: string;
  /** Task activation copy for an Amma-held Stellar wallet. Without it the screen is unchanged. */
  activation?: {
    notActivated: ReactNode;
    activating: ReactNode;
    delayed: ReactNode;
    failed: ReactNode;
    active: (partner: string | null) => ReactNode;
    /** Primary action for a wallet that is not activated yet. Without it only Receive is offered. */
    goToPartner?: { label: ReactNode; href: string };
  };
};

/**
 * The four things a balance can be (G-16): loading, could not read it, read it and it is empty, or ready.
 * A failed load never looks like an empty wallet. When a refresh fails after a good load, `stale` keeps the list and
 * adds a warning with Retry. `children` is the ready list.
 */
export function BalanceState({
  state,
  stale,
  activation,
  onRetry,
  retrying = false,
  receiveHref,
  labels,
  children,
}: {
  state: BalanceViewState;
  stale: boolean;
  /** Where this Amma-held Stellar wallet stands with task activation. Optional: omitted when the server has nothing to say. */
  activation?: { state: ActivationState; partner?: string | null } | null;
  onRetry: () => void;
  retrying?: boolean;
  receiveHref: string;
  labels: BalanceStateLabels;
  children?: ReactNode;
}) {
  const copy = labels.activation;
  const activationLine = copy && activation ? ({ not_activated: copy.notActivated, activating: copy.activating, delayed: copy.delayed, failed: copy.failed, active: copy.active(activation.partner ?? null) } as const)[activation.state] : null;
  return (
    <>
      {stale && (
        <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-stellar-text">
          <span>{labels.stale}</span>
          <button type="button" onClick={onRetry} disabled={retrying} className="shrink-0 font-medium text-stellar-link disabled:opacity-50">
            {labels.retry}
          </button>
        </div>
      )}
      {state === "loading" ? (
        <div role="status" aria-label={labels.loading ?? "Loading"} className="flex justify-center py-12">
          <Loader2 className="animate-spin text-stellar-muted" size={32} aria-hidden="true" />
        </div>
      ) : state === "error" ? (
        <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-8 text-center">
          <p className="font-medium text-stellar-text">{labels.loadFailed}</p>
          <p className="mt-1 text-sm text-stellar-muted">{labels.loadFailedHint}</p>
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="mt-4 rounded-lg bg-stellar-blue px-4 py-2 text-sm font-medium text-white hover:bg-stellar-purple disabled:opacity-50"
          >
            {labels.retry}
          </button>
        </div>
      ) : state === "unfunded" ? (
        <div data-testid="unfunded" data-activation={activationLine ? activation!.state : undefined} className="rounded-xl border border-stellar-border px-5 py-8 text-center">
          {activationLine && activation!.state !== "active" ? (
            <p role="status" className="text-stellar-muted">{activationLine}</p>
          ) : (
            <>
              {activationLine && <p className="mb-2 font-medium text-stellar-text">{activationLine}</p>}
              <p className="text-stellar-muted">{labels.empty}</p>
            </>
          )}
          {activation?.state === "not_activated" && copy?.goToPartner ? (
            <>
              <a
                href={copy.goToPartner.href}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-stellar-blue px-4 py-2 text-sm font-medium text-white hover:bg-stellar-purple"
              >
                {copy.goToPartner.label}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              <div>
                <Link to={receiveHref} className="mt-2 inline-flex min-h-11 items-center px-2 text-sm font-medium text-stellar-link underline">
                  {labels.receive}
                </Link>
              </div>
            </>
          ) : (
            <Link
              to={receiveHref}
              className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-stellar-blue px-4 py-2 text-sm font-medium text-white hover:bg-stellar-purple"
            >
              {labels.receive}
            </Link>
          )}
        </div>
      ) : (
        <>
          {state === "ready" && activation?.state === "active" && activation.partner && activationLine && (
            <p data-testid="activated-by" className="mb-3 text-sm text-stellar-muted">{activationLine}</p>
          )}
          {children}
        </>
      )}
    </>
  );
}
