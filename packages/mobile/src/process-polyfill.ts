// Make sure a Node-style `process` with `env` and `version` exists.
// Hermes (Expo SDK 58) provides `process` without `version`, and
// readable-stream reads process.version.slice() at import time.
export function ensureProcess(g: any): void {
  if (typeof g.process === "undefined" || g.process === null) {
    g.process = {};
  }
  if (!g.process.env) {
    g.process.env = {};
  }
  if (typeof g.process.version !== "string") {
    g.process.version = "v18.0.0";
  }
}
