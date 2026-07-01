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

async function loadVaultUncached(): Promise<VaultData> {
  const account = process.env.USER || process.env.USERNAME || 'user';
  let raw: string | null = null;

  if (crossKeychain?.getPassword) {
    try {
      raw = await crossKeychain.getPassword(VAULT_SERVICE, account);
    } catch {}
  }

  if (!raw && isMac()) {
    try {
      raw = execSync(
        `security find-generic-password -s ${JSON.stringify(VAULT_SERVICE)} -a ${JSON.stringify(account)} -w`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
    } catch {}
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.accounts) return parsed as VaultData;
    } catch {}
  }

  // fallback file
  const f = path.join(getAsxConfigDir(), 'vault.json');
  if (fs.existsSync(f)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (parsed && parsed.accounts) return parsed as VaultData;
    } catch {}
  }

  return { version: 1, accounts: {} };
}

async function saveVault(v: VaultData): Promise<void> {
  vaultCache = Promise.resolve(v); // keep cache in sync with what we just wrote
  const data = JSON.stringify(v);
  const account = process.env.USER || process.env.USERNAME || 'user';

  if (crossKeychain?.setPassword) {
    try {
      await crossKeychain.setPassword(VAULT_SERVICE, account, data);
      return;
    } catch {}
  }

  if (isMac()) {
    try {
      execSync(
        `security add-generic-password -s ${JSON.stringify(VAULT_SERVICE)} -a ${JSON.stringify(account)} -w ${JSON.stringify(data)} -U`,
        { stdio: 'ignore' }
      );
      return;
    } catch {}
  }

  // fallback file
  const f = path.join(getAsxConfigDir(), 'vault.json');
  ensureDirFor(f);
  fs.writeFileSync(f, data);
  try { fs.chmodSync(f, 0o600); } catch {}
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
