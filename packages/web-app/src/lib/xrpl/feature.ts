export const xrplEnabled = import.meta.env.VITE_XRPL_ENABLED === "true";
export const XRP_LOCK_EVENT = "amma:xrpl:lock";
export const XRP_PAYMENT_LOCK_EVENT = "amma:xrpl:payment-lock";
export const xrplPaymentsEnabled = xrplEnabled && import.meta.env.VITE_XRPL_PAYMENTS_ENABLED === "true";
