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
