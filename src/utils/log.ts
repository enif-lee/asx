// Debug logging for proxy/exec. Silent unless ASX_DEBUG is set (via `asx e -d`).
// Always writes to stderr so it never corrupts the agent binary's stdout.
export function dlog(...args: any[]): void {
  if (process.env.ASX_DEBUG) console.error(...args);
}
