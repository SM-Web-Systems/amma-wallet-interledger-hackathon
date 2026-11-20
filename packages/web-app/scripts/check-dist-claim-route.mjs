// Checks a built web-app `dist` for the LMS claim route (guards against PR #200's failure:
// /lms/claim compiled out of the production build). Static check only: it proves the route and
// page code are in the files, not that a server serves them or that the route renders.
// Usage: node scripts/check-dist-claim-route.mjs [dist-dir]   (default ./dist; exit 1 on failure)
import { readdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function checkDist(dir) {
  const problems = [];
  const assets = join(dir, "assets");
  if (!existsSync(join(dir, "index.html")) || !existsSync(assets)) return { ok: false, problems: [`${dir} is not a built dist (no index.html or assets/)`] };
  const js = readdirSync(assets).filter((f) => f.endsWith(".js"));
  const read = (f) => readFileSync(join(assets, f), "utf8");
  const quotes = [String.fromCharCode(34), String.fromCharCode(39), String.fromCharCode(96)]; // " ' ` (the minifier picks one)
  const hasRoute = (text) => quotes.some((q) => text.includes(`path:${q}/lms/claim${q}`));
  if (!js.some((f) => hasRoute(read(f)))) problems.push("no JS chunk contains a route with path /lms/claim");
  const pages = js.filter((f) => /^LmsClaimSign-.*\.js$/.test(f));
  if (!pages.length) problems.push("no LmsClaimSign-*.js chunk (the claim page was dropped from the build)");
  else if (!pages.some((f) => read(f).includes("Approve LMS reward claim"))) problems.push('LmsClaimSign chunk lacks the "Approve LMS reward claim" page text');
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const dir = process.argv[2] ?? "dist";
  const r = checkDist(dir);
  if (r.ok) console.log(`OK: ${dir} contains the /lms/claim route and the LmsClaimSign page`);
  else { for (const p of r.problems) console.error(`FAIL: ${p}`); process.exit(1); }
}
