import { platform } from 'node:os';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { getAsxConfigDir, ensureDirFor } from '../utils/platform.js';

// cross-keychain types are loose; we use any + try/catch for safety.
// NOTE: this file compiles to ESM, where bare `require` is undefined — use
// createRequire, else the keychain client never loads and every getSecret falls
// back to the file vault.
let crossKeychain: any = null;
try {
  crossKeychain = createRequire(import.meta.url)('cross-keychain');
} catch {
  // Will fallback
}

const VAULT_SERVICE = 'asx';
const VAULT_ACCOUNT = 'vault';

// The vault holds only the credential. All account metadata (email, label, etc.)
// lives in account-store (accounts.json) — the single source of truth for it.
interface VaultAccount {
  credential: string;
  addedAt: string;
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

// Storage policy: platform keychain first. A 0600 file is only a fallback when
// the keychain is unavailable.
function vaultFile(): string { return path.join(getAsxConfigDir(), 'vault.json'); }

async function readKeychain(): Promise<string | null> {
  if (crossKeychain?.getPassword) {
    try { return await crossKeychain.getPassword(VAULT_SERVICE, VAULT_ACCOUNT); } catch {}
  }
  if (isMac()) {
    try {
      return execSync(
        `security find-generic-password -s ${JSON.stringify(VAULT_SERVICE)} -a ${JSON.stringify(VAULT_ACCOUNT)} -w`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
    } catch {}
  }
  return null;
}

async function writeKeychain(data: string): Promise<boolean> {
  if (crossKeychain?.setPassword) {
    try { await crossKeychain.setPassword(VAULT_SERVICE, VAULT_ACCOUNT, data); return true; } catch {}
  }
  if (isMac()) {
    try {
      execSync(
        `security add-generic-password -s ${JSON.stringify(VAULT_SERVICE)} -a ${JSON.stringify(VAULT_ACCOUNT)} -w ${JSON.stringify(data)} -U`,
        { stdio: 'ignore' }
      );
      return true;
    } catch {}
  }
  return false;
}

function writeFileVault(data: string): void {
  const f = vaultFile();
  ensureDirFor(f);
  fs.writeFileSync(f, data);
  try { fs.chmodSync(f, 0o600); } catch {}
}

function removeFileVault(): void {
  try { fs.rmSync(vaultFile(), { force: true }); } catch {}
}

async function loadVaultUncached(): Promise<VaultData> {
  const parse = (raw: string | null): VaultData | null => {
    if (!raw) return null;
    try { const p = JSON.parse(raw); return p && p.accounts ? (p as VaultData) : null; } catch { return null; }
  };

  const f = vaultFile();
  const keychainVault = parse(await readKeychain());
  if (keychainVault) return keychainVault;
  if (fs.existsSync(f)) return parse(fs.readFileSync(f, 'utf8')) || { version: 1, accounts: {} };

  return { version: 1, accounts: {} };
}

async function saveVault(v: VaultData): Promise<void> {
  vaultCache = Promise.resolve(v); // keep cache in sync with what we just wrote
  const data = JSON.stringify(v);
  if (await writeKeychain(data)) {
    removeFileVault();
    return;
  }
  writeFileVault(data);
}

function makeKey(provider: string, name: string): string {
  return `${provider}:${name}`;
}

export async function setSecret(provider: string, name: string, value: string): Promise<void> {
  const key = makeKey(provider, name);
  const v = await loadVault();
  v.accounts[key] = { credential: value, addedAt: new Date().toISOString() };
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
