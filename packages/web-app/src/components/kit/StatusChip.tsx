import type { ReactNode } from "react";
import { TONE_CLASSES, type Tone } from "../../lib/payment-display";

/** The one small status pill for every rail. Colours come from the single tone map in `lib/payment-display.ts`. */
export function StatusChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}>{children}</span>;
}
