export interface ApprovalTarget { walletId: string; intentId: string }
// Links carry selectors only. Payment fields always come from the owner API.
export function parseApprovalTarget(search: string): ApprovalTarget | null {
  const query=new URLSearchParams(search);
  if(!query.size)return null;
  const walletId=query.get("walletId"),intentId=query.get("intentId");
  if(query.size!==2||!walletId||!intentId||!/^[1-9]\d{0,14}$/.test(walletId)||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(intentId))throw new Error("INVALID_APPROVAL_LINK");
  return {walletId,intentId};
}
export function approvalReturnPath(value: unknown): string | null {
  if(typeof value!=="string"||!value.startsWith("/xrpl?")||value.length>200)return null;
  try {const target=parseApprovalTarget(value.slice(5));return target?`/xrpl?walletId=${target.walletId}&intentId=${target.intentId}`:null;}catch{return null;}
}
