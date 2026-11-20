import { readFileSync } from "fs";
import { join } from "path";

/**
 * server.ts as source text, with the sign-and-submit handler (moved to routes/sign-and-submit.ts so it can be tested with
 * app.inject) put back at its call site. Source-level tests that slice the sign-and-submit route keep working unchanged.
 */
export function serverSource(): string {
  return serverSourceWith("");
}

/** serverSource() with `line` added at the top of the sign-and-submit handler body: proves a guard would see code reintroduced there. */
export function serverSourceWith(line: string): string {
  const server = readFileSync(join(__dirname, "..", "server.ts"), "utf-8");
  const original = readFileSync(join(__dirname, "..", "routes", "sign-and-submit.ts"), "utf-8");
  const open = "return async (request: FastifyRequest, reply: FastifyReply) => {";
  const handler = line ? original.replace(open, `${open}
${line}`) : original;
  const call = "signAndSubmitHandler({ provider: custodyProvider, flags: custodyFlags }),";
  const start = handler.indexOf("return async (request: FastifyRequest, reply: FastifyReply) => {");
  if (!server.includes(call) || start < 0) throw new Error("serverSource: sign-and-submit handler call or body not found");
  return server.replace(call, handler.slice(start).replace(/^return /, ""));
}
