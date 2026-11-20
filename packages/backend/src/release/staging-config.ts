export function stagingIdentity(args:string[],env:NodeJS.ProcessEnv=process.env) {
  const fields=["--expect-database=","--expect-db-host=","--expect-revision="];
  if(args.length!==3||fields.some(prefix=>args.filter(arg=>arg.startsWith(prefix)).length!==1))throw new Error("Explicit staging identity required");
  const value=(prefix:string)=>args.find(arg=>arg.startsWith(prefix))!.slice(prefix.length);
  const database=value(fields[0]),host=value(fields[1]),revision=value(fields[2]);
  if(!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(database)||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/.test(host)||!/^[a-f0-9]{40}$/.test(revision)||env.AMMA_BUILD_REVISION!==revision)throw new Error("Staging revision/database identity mismatch");
  if(env.STELLAR_NETWORK!=="testnet"||env.XRPL_NETWORK!=="testnet"||["XRPL_ENABLED","XRPL_PAYMENTS_ENABLED","XRPL_INTEGRATION_ENABLED","XRPL_RECONCILIATION_ENABLED","XRPL_MONITORING_ENABLED"].some(name=>env[name]!=="true"))throw new Error("Explicit isolated Testnet flags and recovery/monitoring required");
  return {database,host,revision};
}
