import { useEffect, useId, useRef, type ReactNode } from "react";

export type ReviewRow = { label: ReactNode; value: ReactNode };

/**
 * The step before money moves: what is being sent and what it costs, with Back and Confirm.
 * Nothing is signed until Confirm. The heading takes focus when the panel opens so a screen reader starts at the title.
 * `children` sit under the rows and above the buttons (a warning, a password field, a fee note).
 */
export function ReviewPanel({
  title,
  rows,
  onBack,
  onConfirm,
  busy = false,
  error,
  backLabel,
  confirmLabel,
  busyLabel,
  confirmDisabled = false,
  titleId: titleIdProp,
  errorId,
  confirmDescribedBy,
  children,
}: {
  title: ReactNode;
  rows: ReviewRow[];
  onBack: () => void;
  onConfirm: () => void;
  busy?: boolean;
  error?: ReactNode;
  backLabel: ReactNode;
  confirmLabel: ReactNode;
  busyLabel: ReactNode;
  confirmDisabled?: boolean;
  /** Fixed ids for tests and for links that point at the heading or the error. */
  titleId?: string;
  errorId?: string;
  /** id of the text that says why Confirm is off (for example "Working out the fee…"). */
  confirmDescribedBy?: string;
  children?: ReactNode;
}) {
  const generatedId = useId();
  const titleId = titleIdProp ?? generatedId;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const hasError = !(error == null || error === false || (typeof error === "string" && !error.trim()));
  return (
    <div className="bg-stellar-card border border-stellar-border rounded-2xl p-6 space-y-4 max-w-lg">
      <h2 id={titleId} ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-stellar-text focus:outline-none">
        {title}
      </h2>
      <dl className="space-y-3 text-sm">
        {rows.map((row, i) => (
          <div key={i}>
            <dt className="ui-label">{row.label}</dt>
            <dd className="text-stellar-text break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
      {children}
      {hasError && (
        <p id={errorId} role="alert" className="text-sm text-stellar-danger-text">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <button type="button" onClick={onBack} disabled={busy} className="ui-btn ui-btn-secondary">
          {backLabel}
        </button>
        <button type="button" onClick={onConfirm} disabled={busy || confirmDisabled} aria-describedby={confirmDescribedBy} className="ui-btn ui-btn-primary">
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </div>
  );
}
