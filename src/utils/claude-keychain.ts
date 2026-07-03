import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';

const SERVICE_PREFIX = 'Claude Code-credentials';

export function getClaudeKeychainService(configDir?: string | null): string {
  if (!configDir) return SERVICE_PREFIX;
  const hash = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `${SERVICE_PREFIX}-${hash}`;
}

function currentUser(): string {
  try {
    return os.userInfo().username || process.env.USER || 'user';
  } catch {
    return process.env.USER || 'user';
  }
}

export function readClaudeKeychainCredential(service: string): string | null {
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', service, '-a', currentUser(), '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function writeClaudeKeychainCredential(service: string, raw: string): void {
  execFileSync('security', ['add-generic-password', '-s', service, '-a', currentUser(), '-w', raw, '-U'], {
    stdio: 'ignore',
  });
}

export function deleteClaudeKeychainCredential(service: string): void {
  try {
    execFileSync('security', ['delete-generic-password', '-s', service, '-a', currentUser()], {
      stdio: 'ignore',
    });
  } catch {}
}
