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
  // dedupe by provider+name
  store.accounts = store.accounts.filter(a => !(a.provider === full.provider && a.name === full.name));
  store.accounts.push(full);
  saveStore(store);
  return full;
}

export function removeAccount(provider: string, name: string): boolean {
  const store = loadStore();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter(a => !(a.provider === provider && a.name === name));
  saveStore(store);
  return store.accounts.length < before;
}

export function getAccount(provider: string, name: string): AccountRecord | undefined {
  return loadStore().accounts.find(a => a.provider === provider && a.name === name);
}

export function setActive(provider: string, name: string): void {
  // lightweight active marker; real active is the injected creds
  const p = path.join(path.dirname(getAsxAccountsPath()), '.active.json');
  ensureDirFor(p);
  const act = { [provider]: name, updated: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(act, null, 2));
}

export function getActive(provider: string): string | undefined {
  const p = path.join(path.dirname(getAsxAccountsPath()), '.active.json');
  if (!fs.existsSync(p)) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j[provider];
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
