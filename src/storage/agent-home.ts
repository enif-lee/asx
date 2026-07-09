import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAsxProfilesDir } from '../utils/platform.js';
import { safeProfileDirName } from './profile-home.js';

function ensureHome700(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

export function agentScratchHome(agentProvider: string, accountName: string): string {
  const dir = path.join(getAsxProfilesDir(), '.agents', safeProfileDirName(agentProvider, accountName));
  ensureHome700(path.dirname(dir));
  ensureHome700(dir);
  return dir;
}

export function crossSessionAgentHome(agentProvider: string, accountName: string, runId = crypto.randomUUID()): string {
  const base = path.join(getAsxProfilesDir(), '.agents', 'sessions');
  const dir = path.join(base, `${safeProfileDirName(agentProvider, accountName)}-${runId}`);
  ensureHome700(base);
  ensureHome700(dir);
  return dir;
}

export function removeCrossSessionAgentHome(dir: string): void {
  const base = path.resolve(getAsxProfilesDir(), '.agents', 'sessions');
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Refusing to remove non-cross-session home: ${dir}`);
  }
  // Codex may still be flushing session files when the process exits; a single
  // rm can race with writers and surface ENOTEMPTY even with recursive+force.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (e) {
      lastErr = e;
      // brief busy-wait (sync) so callers stay sync; ~20ms * attempt
      const end = Date.now() + 20 * (attempt + 1);
      while (Date.now() < end) { /* spin */ }
    }
  }
  throw lastErr;
}
