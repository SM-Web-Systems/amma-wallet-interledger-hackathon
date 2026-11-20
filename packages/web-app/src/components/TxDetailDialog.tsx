import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import TxConfirmation from "./TxConfirmation";
import type { StellarNetwork } from "../lib/stellar-tx-details";

/** Modal wrapper for the same transaction detail the Send page shows. Escape and Close dismiss it; focus returns to the opener. */
export default function TxDetailDialog({ hash, network, onClose }: { hash: string; network: StellarNetwork; onClose: () => void }) {
  const { t } = useTranslation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Keep Tab inside the dialog.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const f = dialogRef.current.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),[tabindex='-1']");
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-2 sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tx-detail-title"
        onKeyDown={onKeyDown}
        className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-2xl"
      >
        <TxConfirmation hash={hash} network={network} showHistoryLink={false} headingRef={headingRef} titleId="tx-detail-title" />
        <button type="button" onClick={onClose} className="mt-2 w-full py-3 rounded-lg bg-stellar-card border border-stellar-border text-stellar-text min-h-[44px]">
          {t("txDetail.close", "Close")}
        </button>
      </div>
    </div>
  );
}
