// Precompile the backend once at image build time so the container starts with
// plain `node` instead of transpiling every TypeScript file on each start.
// Files are transpiled one-to-one (no bundling), so the dist/ tree mirrors src/
// and every __dirname-relative path (SQL migrations, icon cache) still resolves.
import { build } from "esbuild";
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = "src";
const OUT = "dist";
// test-support/ holds helpers that only tests import (e.g. server-source.ts reads source files): never emitted into dist.
const isTest = (f) => /\.(test|spec|test-support)\.ts$/.test(f) || f.includes(`${SRC}/test-integration/`) || relative(SRC, f).split(sep)[0] === "test-support";

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

rmSync(OUT, { recursive: true, force: true });
const files = walk(SRC);
const entryPoints = files.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !isTest(f));

await build({
  entryPoints,
  outdir: OUT,
  outbase: SRC,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  // Lower `await import("./x")` to require(). Left as a native import() in CommonJS
  // output, Node resolves it as ESM, which needs the ".js" extension, so lazily
  // loaded modules (password reset email, 2FA code, Stellar client) fail at runtime.
  supported: { "dynamic-import": false },
  logLevel: "warning",
});

// Runtime data files read from disk next to the code.
for (const f of files) {
  if (/\.(sql|json)$/.test(f) && !isTest(f)) cpSync(f, join(OUT, relative(SRC, f)));
}
// Guard: no relative native import() may survive in the output (see above).
const leftovers = walk(OUT).filter((f) => f.endsWith(".js") && /\bimport\(\s*["'`]\.{1,2}\//.test(readFileSync(f, "utf8")));
if (leftovers.length) {
  console.error(`relative dynamic import() left in: ${leftovers.join(", ")}`);
  process.exit(1);
}
console.log(`built ${entryPoints.length} files into ${OUT}/`);
