import chalk from 'chalk';

export function renderBar(remainingPct: number, width = 20): string {
  const pct = Math.max(0, Math.min(100, remainingPct));
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  let bar = '█'.repeat(filled) + '░'.repeat(empty);
  if (pct >= 90) bar = chalk.green(bar);  // lots remaining = good
  else if (pct >= 70) bar = chalk.yellow(bar);
  else bar = chalk.red(bar);  // little remaining = bad
  return '[' + bar + ']';
}

// Format a reset timestamp as local time + time remaining, e.g. "resets 15:09 (2h 41m left)".
// Accepts a Date, ms epoch, or ISO string. Returns '' on bad input.
export function formatReset(when: Date | number | string): string {
  const d = when instanceof Date ? when : new Date(when);
  const t = d.getTime();
  if (isNaN(t)) return '';
  const local = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const diff = t - Date.now();
  if (diff <= 0) return `resets ${local} (now)`;
  const mins = Math.round(diff / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  const left = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return `resets ${local} (${left} left)`;
}
