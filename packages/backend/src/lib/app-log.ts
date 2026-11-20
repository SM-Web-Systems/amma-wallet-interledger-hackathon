// A logger for code that has no request in hand (mail, jobs). It is the server's own
// redacting logger once the server has started (see server.ts), and a minimal
// structured line on stderr before that, so nothing bypasses redaction through console.
export interface AppLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const fallback: AppLogger = {
  info: (obj, msg) => write("info", obj, msg),
  warn: (obj, msg) => write("warn", obj, msg),
  error: (obj, msg) => write("error", obj, msg),
};

function write(level: string, obj: Record<string, unknown>, msg: string) {
  process.stderr.write(JSON.stringify({ level, time: Date.now(), ...obj, msg }) + "\n");
}

let current: AppLogger = fallback;

export function setAppLogger(logger: AppLogger | null): void {
  current = logger ?? fallback;
}

export function appLog(): AppLogger {
  return current;
}
