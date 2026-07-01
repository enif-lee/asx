import fs from 'node:fs';
import path from 'node:path';
import { getAsxAccountsPath, ensureDirFor } from '../utils/platform.js';
import { z } from 'zod';

const AccountSchema = z.object({
  provider: z.string(),
  name: z.string(),
  label: z.string().optional(),
  email: z.string().optional(), // extracted from login info
  addedAt: z.string(),
  meta: z.record(z.string(), z.any()).optional(),
});

export type AccountRecord = z.infer<typeof AccountSchema>;

const StoreSchema = z.object({
  version: z.number().default(1),
  accounts: z.array(AccountSchema).default([]),
});

function loadStore(): z.infer<typeof StoreSchema> {
  const p = getAsxAccountsPath();
  if (!fs.existsSync(p)) return { version: 1, accounts: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return StoreSchema.parse(raw);
  } catch {
    return { version: 1, accounts: [] };
  }
}

function saveStore(data: z.infer<typeof StoreSchema>) {
  const p = getAsxAccountsPath();
  ensureDirFor(p);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  try { fs.chmodSync(p, 0o600); } catch {}
}

export function listAccounts(provider?: string): AccountRecord[] {
  const store = loadStore();
  return provider ? store.accounts.filter(a => a.provider === provider) : store.accounts;
}

export function addAccount(rec: Omit<AccountRecord, 'addedAt'> & { addedAt?: string }): AccountRecord {
  const store = loadStore();
  const full: AccountRecord = {
    ...rec,
    addedAt: rec.addedAt || new Date().toISOString(),
  };

  // Enforce global name uniqueness (names identify accounts across providers)
  const conflict = store.accounts.find(a => a.name === full.name && a.provider !== full.provider);
  if (conflict) {
    throw new Error(`Name "${full.name}" is already used by provider "${conflict.provider}". Account names must be unique.`);
  }

  // dedupe by provider+name (overwrite for same provider)
  store.accounts = store.accounts.filter(a => !(a.provider === full.provider && a.name === full.name));
  store.accounts.push(full);
  saveStore(store);
  return full;
}

export function removeAccount(provider: string, name: string): boolean {
  const prov = canonicalProvider(provider);
  const store = loadStore();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter(a => !(canonicalProvider(a.provider) === prov && a.name === name));
  saveStore(store);
  return store.accounts.length < before;
}

function canonicalProvider(p: string): string {
  return p.toLowerCase();
}

export function getAccount(provider: string, name: string): AccountRecord | undefined {
  const prov = canonicalProvider(provider);
  return loadStore().accounts.find(a => canonicalProvider(a.provider) === prov && a.name === name);
}

export function setActive(provider: string, name: string): void {
  // lightweight active marker; real active is the injected creds
  const prov = canonicalProvider(provider);
  const p = path.join(path.dirname(getAsxAccountsPath()), '.active.json');
  ensureDirFor(p);
  const act = { [prov]: name, updated: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(act, null, 2));
}

export function getActive(provider: string): string | undefined {
  const prov = canonicalProvider(provider);
  const p = path.join(path.dirname(getAsxAccountsPath()), '.active.json');
  if (!fs.existsSync(p)) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j[prov];
  } catch { return undefined; }
}

export function getNextAccount(provider: string): string | null {
  const accounts = listAccounts(provider);
  if (accounts.length === 0) return null;
  // Use addition order from storage
  const names = accounts.map(a => a.name);
  const active = getActive(provider);
  if (!active) return names[0];
  const idx = names.indexOf(active);
  if (idx === -1) return names[0];
  return names[(idx + 1) % names.length];
}

// Support for provider-less name operations (names are globally unique)
export function getAccountByName(name: string): AccountRecord | undefined {
  const matches = loadStore().accounts.filter(a => a.name === name);
  if (matches.length > 1) {
    throw new Error(`Name "${name}" is ambiguous (matches multiple providers). Use provider/name form.`);
  }
  return matches[0];
}

export function removeAccountByName(name: string): boolean {
  const store = loadStore();
  const before = store.accounts.length;
  const matches = store.accounts.filter(a => a.name === name);
  if (matches.length > 1) {
    throw new Error(`Name "${name}" is ambiguous (matches multiple providers).`);
  }
  store.accounts = store.accounts.filter(a => a.name !== name);
  saveStore(store);
  return store.accounts.length < before;
}

export function renameAccount(oldName: string, newName: string): void {
  if (!oldName || !newName || oldName === newName) {
    throw new Error('Invalid rename: from and to names must be different and non-empty');
  }

  const store = loadStore();
  const idx = store.accounts.findIndex(a => a.name === oldName);
  if (idx === -1) {
    throw new Error(`Account "${oldName}" not found`);
  }

  const acct = store.accounts[idx];

  // Check global name uniqueness (different provider)
  const crossConflict = store.accounts.find(a => a.name === newName && a.provider !== acct.provider);
  if (crossConflict) {
    throw new Error(`Name "${newName}" is already used by provider "${crossConflict.provider}". Account names must be unique.`);
  }

  // Update the name
  store.accounts[idx].name = newName;

  saveStore(store);

  // Update active markers if this name was active
  const activePath = path.join(path.dirname(getAsxAccountsPath()), '.active.json');
  if (fs.existsSync(activePath)) {
    try {
      const act = JSON.parse(fs.readFileSync(activePath, 'utf8'));
      let changed = false;
      for (const prov of Object.keys(act)) {
        if (act[prov] === oldName) {
          act[prov] = newName;
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(activePath, JSON.stringify(act, null, 2));
      }
    } catch {}
  }
}
