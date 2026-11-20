/** Amma Wallet mark: a jade wallet with the marigold star. Flat, so it reads at 16px. */
export function BrandMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} role="img" aria-label="Amma Wallet">
      <rect x="12" y="7" width="40" height="28" rx="7" fill="#0b5548" transform="rotate(-8 32 21)" />
      <rect x="5" y="17" width="54" height="41" rx="11" fill="#0b7a65" />
      <rect x="40" y="30" width="19" height="15" rx="7.5" fill="#0b5548" />
      <circle cx="49" cy="37.5" r="2.6" fill="#f2a93b" />
      <path transform="translate(12.5 24.5)" fill="#f2a93b" d="M12 0c.6 6.2 5.8 11.4 12 12-6.2.6-11.4 5.8-12 12-.6-6.2-5.8-11.4-12-12C6.2 11.4 11.4 6.2 12 0Z" />
    </svg>
  );
}

/** Mark plus wordmark, for headers. */
export function BrandLockup({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <BrandMark size={size} />
      <span className="text-[15px] font-semibold tracking-tight text-stellar-text">
        Amma<span className="font-normal text-stellar-muted"> Wallet</span>
      </span>
    </span>
  );
}
