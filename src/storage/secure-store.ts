import { platform } from 'node:os';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { getAsxConfigDir, ensureDirFor } from '../utils/platform.js';

// cross-keychain types are loose; we use any + try/catch for safety.
// NOTE: this file compiles to ESM, where bare `require` is undefined — use
// createRequire, else the keychain client never loads and every getSecret falls
// back to a broken path (security -w returns hex → JSON.parse fails → null).
let crossKeychain: any = null;
try {
  crossKeychain = createRequire(import.meta.url)('cross-keychain');
} catch {
  // Will fallback
}

const VAULT_SERVICE = 'asx';
const VAULT_ACCOUNT = 'vault';

interface VaultAccount {
  credential: string;
  email?: string;
  label?: string;
  addedAt: string;
  meta?: any;
}

interface VaultData {
  version: number;
  accounts: Record<string, VaultAccount>;  // key = `${provider}:${name}`
}

function isMac() { return platform() === 'darwin'; }

// Cache the vault per process so one command triggers at most one keychain read
// (each read can pop a macOS keychain-access prompt). Invalidated on save.
let vaultCache: Promise<VaultData> | null = null;
function loadVault(): Promise<VaultData> {
  if (!vaultCache) vaultCache = loadVaultUncached();
  return vaultCache;
}

// Storage policy: a 0600 file is the default vault. The macOS keychain reprompts
// ("Always Allow" doesn't stick — every save rewrites the item and resets its ACL),
// and the native tools already keep these same tokens in plaintext ~/.codex/auth.json
// etc. Opt into the keychain with ASX_KEYCHAIN=1.
function useKeychain(): boolean { return !!process.env.ASX_KEYCHAIN; }
function vaultFile(): string { return path.join(getAsxConfigDir(), 'vault.json'); }

function readKeychain(): string | null {
  const account = process.env.USER || process.env.USERNAME || 'user';
  if (isMac()) {
    try {
      return execSync(
        `security find-generic-password -s ${JSON.stringify(VAULT_SERVICE)} -a ${JSON.stringify(account)} -w`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
    } catch {}
  }
  return null;
}

function writeFileVault(data: string): void {
  const f = vaultFile();
  ensureDirFor(f);
  fs.writeFileSync(f, data);
  try { fs.chmodSync(f, 0o600); } catch {}
}

async function loadVaultUncached(): Promise<VaultData> {
  const parse = (raw: string | null): VaultData | null => {
    if (!raw) return null;
    try { const p = JSON.parse(raw); return p && p.accounts ? (p as VaultData) : null; } catch { return null; }
  };

  // Default: file-first (no keychain prompt).
  const f = vaultFile();
  if (fs.existsSync(f)) {
    const v = parse(fs.readFileSync(f, 'utf8'));
    if (v) return v;
  }

  // No file yet: one-time migration from a legacy keychain vault (or opt-in keychain).
  // Prefer crossKeychain.getPassword — the `security -w` fallback returns the item as
  // hex, which won't parse. This read happens once, then the file takes over.
  const account = process.env.USER || process.env.USERNAME || 'user';
  let raw: string | null = null;
  if (crossKeychain?.getPassword) {
    try { raw = await crossKeychain.getPassword(VAULT_SERVICE, account); } catch {}
  }
  if (!raw) raw = readKeychain();
  const v = parse(raw);
  if (v) {
    // Persist to the file so subsequent runs never touch the keychain again.
    if (!useKeychain()) writeFileVault(JSON.stringify(v));
    return v;
  }

  return { version: 1, accounts: {} };
}

async function saveVault(v: VaultData): Promise<void> {
  vaultCache = Promise.resolve(v); // keep cache in sync with what we just wrote
  const data = JSON.stringify(v);
  writeFileVault(data); // file is the source of truth by default

  if (useKeychain()) {
    const account = process.env.USER || process.env.USERNAME || 'user';
    if (crossKeychain?.setPassword) {
      try { await crossKeychain.setPassword(VAULT_SERVICE, account, data); return; } catch {}
    }
    if (isMac()) {
      try {
        execSync(
          `security add-generic-password -s ${JSON.stringify(VAULT_SERVICE)} -a ${JSON.stringify(account)} -w ${JSON.stringify(data)} -U`,
          { stdio: 'ignore' }
        );
      } catch {}
    }
  }
}

function makeKey(provider: string, name: string): string {
  return `${provider}:${name}`;
}

export async function setSecret(provider: string, name: string, value: string, extra?: { email?: string; label?: string }): Promise<void> {
  const key = makeKey(provider, name);
  const v = await loadVault();
  v.accounts[key] = {
    credential: value,
    addedAt: new Date().toISOString(),
    email: extra?.email,
    label: extra?.label,
  };
  await saveVault(v);
}

export async function getSecret(provider: string, name: string): Promise<string | null> {
  const key = makeKey(provider, name);
  const v = await loadVault();
  return v.accounts[key]?.credential || null;
}

export async function deleteSecret(provider: string, name: string): Promise<void> {
  const key = makeKey(provider, name);
  const v = await loadVault();
  if (v.accounts[key]) {
    delete v.accounts[key];
    await saveVault(v);
  }
}

export async function listSecretsForProvider(provider: string): Promise<string[]> {
  const v = await loadVault();
  return Object.keys(v.accounts)
    .filter(k => k.startsWith(`${provider}:`))
    .map(k => k.split(':')[1]);
}

export async function getAccountInfo(provider: string, name: string): Promise<{ email?: string; label?: string } | null> {
  const key = makeKey(provider, name);
  const v = await loadVault();
  const acc = v.accounts[key];
  if (!acc) return null;
  return { email: acc.email, label: acc.label };
}

export async function hasCrossKeychain(): Promise<boolean> {
  return !!crossKeychain?.setPassword;
}

export async function renameSecret(provider: string, oldName: string, newName: string): Promise<void> {
  if (!oldName || !newName || oldName === newName) {
    throw new Error('Invalid rename: old and new names must be different and non-empty');
  }

  const oldKey = makeKey(provider, oldName);
  const newKey = makeKey(provider, newName);

  const v = await loadVault();
  const existing = v.accounts[oldKey];
  if (!existing) {
    throw new Error(`No secret found for ${provider}/${oldName}`);
  }

  if (v.accounts[newKey]) {
    // Overwrite silently (or could throw, but for rename we allow)
  }

  v.accounts[newKey] = {
    ...existing,
    addedAt: existing.addedAt || new Date().toISOString(),
  };
  delete v.accounts[oldKey];

  await saveVault(v);
}
