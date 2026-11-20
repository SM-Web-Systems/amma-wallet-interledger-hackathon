import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Operator pause switch: a small JSON file {"paused":true|false}, reread on every call so it takes effect at once.
 * No file configured means never paused. A configured file that is missing, oversized or malformed counts as paused
 * (fail closed): the operator asked for a control, and an unreadable control must not mean "go".
 */
export function activationPaused(controlFile: string | undefined): boolean {
  if (!controlFile) return false;
  let fd: number | undefined;
  try {
    fd = openSync(controlFile, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 256) return true;
    const buffer = Buffer.alloc(257);
    const size = readSync(fd, buffer, 0, 257, 0);
    if (size > 256) return true;
    const input = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join() !== "paused" || typeof input.paused !== "boolean") return true;
    return input.paused;
  } catch { return true; }
  finally { if (fd !== undefined) closeSync(fd); }
}
