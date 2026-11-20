import { ceil, requireThat, units, type Allocation, type FundingPlan, type Route } from './domain';

/** Exact linear executable-route allocator, including fixed fees. Enumerating
 * source subsets avoids the usual greedy error when several small fees dominate. */
export function planFunding(amount: string, candidates: Route[], excluded: string[] = [], now = Date.now()): FundingPlan {
  const target = units(amount);
  const routes = candidates.filter(r => !r.source.reason && !excluded.includes(r.source.id)
    && Date.parse(r.expiresAt) > now && units(r.capacity, true) > 0n);
  requireThat(routes.length <= 16, 'TOO_MANY_ROUTES');
  for (const r of routes) {
    units(r.numerator); units(r.denominator); units(r.fee, true); units(r.valuationNumerator); units(r.valuationDenominator);
  }
  // Compare fractions without losing precision. Stable IDs provide repeatability.
  routes.sort((a,b) => {
    const left = units(a.numerator)*units(a.valuationNumerator)*units(b.denominator)*units(b.valuationDenominator);
    const right = units(b.numerator)*units(b.valuationNumerator)*units(a.denominator)*units(a.valuationDenominator);
    return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
  });
  let best: FundingPlan | undefined;
  let bestKey = '';
  for (let mask = 1; mask < 2 ** routes.length; mask++) {
    let remaining = target, cost = 0n;
    const allocations: Allocation[] = [], seen = new Set<string>();
    for (let i = 0; i < routes.length && remaining > 0n; i++) {
      if (!(mask & (1 << i))) continue;
      const route = routes[i];
      // Alternative routes never spend the same underlying source twice.
      if (seen.has(route.source.id)) { remaining = target; break; }
      seen.add(route.source.id);
      const available = units(route.source.available, true), fee = units(route.fee, true);
      const affordable = available > fee ? (available - fee)*units(route.denominator)/units(route.numerator) : 0n;
      const capacity = units(route.capacity, true) < affordable ? units(route.capacity, true) : affordable;
      const receive = capacity < remaining ? capacity : remaining;
      if (!receive) continue;
      const debit = ceil(receive * units(route.numerator), units(route.denominator)) + fee;
      // Cost has 12 guard decimal places in recipient units, preserving close quotes.
      cost += ceil(debit * units(route.valuationNumerator) * 10n**12n, units(route.valuationDenominator));
      if(route.networkFee)cost+=ceil(units(route.networkFee.amount)*units(route.networkFee.valuationNumerator)*10n**12n,units(route.networkFee.valuationDenominator));
      allocations.push({route, receive: receive.toString(), maxDebit: debit.toString()});
      remaining -= receive;
    }
    if (remaining || !allocations.length) continue;
    const fees=new Map<string,{spend:bigint;available:bigint}>();
    for(const a of allocations)if(a.route.networkFee){
      const fee=a.route.networkFee,key=`${a.route.source.asset.chain}:${a.route.source.asset.network}:${a.route.source.walletId}`;
      const prior=fees.get(key)??{spend:0n,available:units(fee.available,true)};
      prior.spend+=units(fee.amount)+(a.route.source.asset.code===fee.asset.code&&!a.route.source.asset.issuer?units(a.maxDebit):0n);fees.set(key,prior);
    }
    if([...fees.values()].some(f=>f.spend>f.available))continue;
    const key = allocations.map(a => a.route.id).sort().join('|');
    if (!best || cost < BigInt(best.cost) || (cost === BigInt(best.cost) &&
      (allocations.length < best.allocations.length || (allocations.length === best.allocations.length && key < bestKey)))) {
      best = {allocations, receive: amount, cost: cost.toString(), simulated: allocations.some(a => !!a.route.simulated),
        expiresAt: new Date(Math.min(...allocations.map(a => Date.parse(a.route.expiresAt)))).toISOString()};
      bestKey = key;
    }
  }
  requireThat(best, 'INSUFFICIENT_SPENDABLE_LIQUIDITY', 409);
  return best;
}
