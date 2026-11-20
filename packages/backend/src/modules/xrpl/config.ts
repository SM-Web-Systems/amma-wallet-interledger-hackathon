import { assertXrplNetworkConfig, xrplMainnetCustodyOn } from "../../lib/custody-networks";

export const TESTNET_ENDPOINTS = Object.freeze([
  "wss://s.altnet.rippletest.net:51233/",
  "wss://testnet.xrpl-labs.com/",
]);

export function readXrplPaymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.XRPL_PAYMENTS_ENABLED ?? "false";
  if (!["true", "false"].includes(flag)) throw new Error("XRPL_PAYMENTS_ENABLED must be true or false");
  if (flag === "true" && !readXrplConfig(env).enabled) throw new Error("XRP payments require XRPL_ENABLED=true");
  return flag === "true";
}

export interface RecoveryConfig {readonly enabled:boolean;readonly intervalMs:number;readonly batchSize:number}
export function readXrplRecoveryConfig(env:NodeJS.ProcessEnv=process.env):RecoveryConfig{
  const flag=env.XRPL_RECONCILIATION_ENABLED??"false";
  if(!["true","false"].includes(flag))throw new Error("XRPL_RECONCILIATION_ENABLED must be true or false");
  if(flag==="true"&&!readXrplConfig(env).enabled)throw new Error("XRP reconciliation requires XRPL_ENABLED=true");
  // Amma-held XRP on mainnet: an interrupted send must be finished by the recovery worker, so it is required.
  if(flag!=="true"&&xrplMainnetCustodyOn(env))throw new Error("XRPL_MAINNET_CUSTODY=on needs XRPL_RECONCILIATION_ENABLED=true");
  const integer=(key:string,fallback:number,min:number,max:number)=>{const raw=env[key]??String(fallback);if(!/^[1-9]\d*$/.test(raw)||Number(raw)<min||Number(raw)>max)throw new Error(`Invalid ${key}`);return Number(raw);};
  return Object.freeze({enabled:flag==="true",intervalMs:integer("XRPL_RECONCILIATION_INTERVAL_MS",15000,5000,60000),batchSize:integer("XRPL_RECONCILIATION_BATCH_SIZE",10,1,20)});
}

/** testnet: Release A. mainnet: only for Amma-held wallet sends, with XRPL_MAINNET_CUSTODY=on (see lib/custody-networks). */
export type XrplNetwork = "testnet" | "mainnet";
/** server_info.network_id each network must report: Testnet 1, Mainnet 0. */
export const NETWORK_IDS: Readonly<Record<XrplNetwork, number>> = Object.freeze({ testnet: 1, mainnet: 0 });
/** Known non-mainnet hosts, refused as mainnet endpoints. */
const NOT_MAINNET_HOST = /(^|\.)(rippletest\.net|xrpl-labs\.com)$|altnet|testnet|devnet/i;

export interface XrplReadConfig {
  readonly enabled: boolean;
  readonly network: XrplNetwork;
  readonly endpoints: readonly string[];
  readonly timeoutMs: number;
  readonly maxLedgerAgeSeconds: number;
}

function mainnetEndpoints(env: NodeJS.ProcessEnv): string[] {
  if (env.XRPL_RPC_URLS !== undefined) throw new Error("On XRPL mainnet set XRPL_MAINNET_WS, not XRPL_RPC_URLS");
  if (!env.XRPL_MAINNET_WS?.trim()) throw new Error("XRPL mainnet needs XRPL_MAINNET_WS (one or two wss:// endpoints)");
  const urls = env.XRPL_MAINNET_WS.split(",").map((raw) => {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { throw new Error("Invalid XRPL_MAINNET_WS endpoint"); }
    if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash || NOT_MAINNET_HOST.test(url.hostname)) {
      throw new Error("XRPL_MAINNET_WS endpoints must be wss:// mainnet endpoints without credentials, query or fragment");
    }
    return url.href;
  });
  if (urls.length < 1 || urls.length > 2 || new Set(urls).size !== urls.length) throw new Error("Configure one or two distinct XRPL mainnet endpoints");
  return urls;
}

export function readXrplConfig(env: NodeJS.ProcessEnv = process.env): XrplReadConfig {
  const enabled = env.XRPL_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") throw new Error("XRPL_ENABLED must be true or false");
  assertXrplNetworkConfig(env);
  const network: XrplNetwork = xrplMainnetCustodyOn(env) ? "mainnet" : "testnet";
  if ((env.XRPL_NETWORK ?? "testnet") !== network) throw new Error("Only XRPL Testnet is supported in Release A");
  const urls = network === "mainnet" ? mainnetEndpoints(env) : (env.XRPL_RPC_URLS ?? TESTNET_ENDPOINTS.join(",")).split(",").map((raw) => {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { throw new Error("Invalid XRPL endpoint configuration"); }
    if (url.username || url.password || url.search || url.hash || !TESTNET_ENDPOINTS.includes(url.href)) {
      throw new Error("XRPL endpoint must be an explicitly supported public Testnet endpoint");
    }
    return url.href;
  });
  if (urls.length < 1 || urls.length > 2 || new Set(urls).size !== urls.length) throw new Error("Configure one or two distinct XRPL Testnet endpoints");
  function integer(name: string, fallback: number, min: number, max: number) {
    const text = env[name] ?? String(fallback);
    if (!/^[1-9]\d*$/.test(text)) throw new Error(`Invalid ${name}`);
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  }
  return Object.freeze({ enabled: enabled === "true", network, endpoints: Object.freeze(urls),
    timeoutMs: integer("XRPL_TIMEOUT_MS", 10000, 1000, 15000),
    maxLedgerAgeSeconds: integer("XRPL_MAX_LEDGER_AGE_SECONDS", 30, 5, 120),
  });
}

export function readXrplIntegrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag=env.XRPL_INTEGRATION_ENABLED??"false";
  if(!["true","false"].includes(flag))throw new Error("XRPL_INTEGRATION_ENABLED must be true or false");
  if(flag==="true"&&!readXrplPaymentsEnabled(env))throw new Error("XRP integration requires XRPL_PAYMENTS_ENABLED=true");
  if(flag==="true"&&readXrplConfig(env).network!=="testnet")throw new Error("XRP tenant integrations are testnet only; turn XRPL_INTEGRATION_ENABLED off on mainnet");
  return flag==="true";
}

export interface MonitorConfig { enabled:boolean;intervalMs:number;pendingSeconds:number;/** The network the monitor reports on (testnet when not given). */ network?:XrplNetwork }
export function readMonitorConfig(env:NodeJS.ProcessEnv=process.env):MonitorConfig {
  const flag=env.XRPL_MONITORING_ENABLED??"false";
  if(!["true","false"].includes(flag))throw new Error("Invalid XRPL_MONITORING_ENABLED");
  if(flag==="true"&&!readXrplConfig(env).enabled)throw new Error("XRPL monitoring requires XRPL_ENABLED=true");
  const integer=(name:string,fallback:number,min:number,max:number)=>{const input=env[name]??String(fallback);if(!/^[1-9]\d*$/.test(input)||Number(input)<min||Number(input)>max)throw new Error(`Invalid ${name}`);return Number(input);};
  return {enabled:flag==="true",intervalMs:integer("XRPL_MONITORING_INTERVAL_MS",60000,15000,300000),pendingSeconds:integer("XRPL_PENDING_ALERT_SECONDS",300,120,3600),network:readXrplConfig(env).network};
}
