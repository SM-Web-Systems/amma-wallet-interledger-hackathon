import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { hashApiKey, checkAndCountRateLimit } from "./tenant-api-key";
import { PaymentError } from "../modules/xrpl/payment";
import type { PaymentApplication } from "../modules/xrpl/payment-service";

export type XrplApplicationScope = "xrpl:payments:create" | "xrpl:payments:read" | "xrpl:receipts:claim";
/** Strict new-route guard. Never invokes the legacy resolver or env fallback. */
export async function requireXrplApplication(rawKey: unknown, owner: number, scope: XrplApplicationScope): Promise<PaymentApplication> {
  if(typeof rawKey!=="string"||rawKey.length<16||rawKey.length>256||/\s/.test(rawKey))throw new PaymentError("APPLICATION_KEY_REQUIRED",401);
  let rows;
  try {
    rows=await db.select({tenantId:schema.tenants.id,name:schema.tenants.name,keyId:schema.tenantApiKeys.id,scopes:schema.tenantApiKeys.scopes,limit:schema.tenantApiKeys.rateLimitPerMinute})
      .from(schema.tenantApiKeys)
      .innerJoin(schema.tenants,eq(schema.tenants.id,schema.tenantApiKeys.tenantId))
      .innerJoin(schema.tenantUsers,and(eq(schema.tenantUsers.tenantId,schema.tenants.id),eq(schema.tenantUsers.userId,owner)))
      .where(and(eq(schema.tenantApiKeys.keyHash,hashApiKey(rawKey)),eq(schema.tenantApiKeys.isActive,true),
        sql`(${schema.tenantApiKeys.expiresAt} IS NULL OR ${schema.tenantApiKeys.expiresAt}>clock_timestamp())`,
        eq(schema.tenants.isActive,true),isNull(schema.tenants.suspendedAt))).limit(1);
  } catch { throw new PaymentError("APPLICATION_AUTH_UNAVAILABLE",503,true); }
  const row=rows[0];
  if(!row)throw new PaymentError("APPLICATION_ACCESS_DENIED",403);
  if(!row.scopes.includes(scope))throw new PaymentError("APPLICATION_SCOPE_REQUIRED",403);
  if(!Number.isSafeInteger(row.tenantId)||row.tenantId<1||!Number.isSafeInteger(row.keyId)||row.keyId<1||row.name.length<1||row.name.length>120||!Number.isInteger(row.limit)||row.limit<1)throw new PaymentError("APPLICATION_ACCESS_DENIED",403);
  if(!checkAndCountRateLimit(row.keyId,row.limit))throw new PaymentError("APPLICATION_RATE_LIMITED",429,true);
  return {tenantId:row.tenantId,keyId:row.keyId,name:row.name};
}
