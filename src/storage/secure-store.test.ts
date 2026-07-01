import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  keychainRaw: null as string | null,
  lastSetAccount: null as string | null,
  failGet: false,
  failSet: false,
}));

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: vi.fn(() => (name: string) => {
      if (name !== 'cross-keychain') return actual.createRequire(import.meta.url)(name);
      return {
        getPassword: vi.fn(async () => {
          if (state.failGet) throw new Error('keychain read failed');
          return state.keychainRaw;
        }),
        setPassword: vi.fn(async (_service: string, account: string, value: string) => {
          if (state.failSet) throw new Error('keychain write failed');
          state.lastSetAccount = account;
          state.keychainRaw = value;
        }),
      };
    }),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error('native keychain unavailable');
  }),
}));

function configDir(home: string): string {
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'asx');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'asx');
  return path.join(home, '.config', 'asx');
}

describe('secure store vault backend', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevAppData: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    state.keychainRaw = null;
    state.lastSetAccount = null;
    state.failGet = false;
    state.failSet = false;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-secure-store-'));
    prevHome = process.env.HOME;
    prevAppData = process.env.APPDATA;
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('stores credentials in keychain when keychain is available', async () => {
    const store = await import('./secure-store.js');

    await store.setSecret('zai', 'personal.zai', 'zai-key');

    expect(state.lastSetAccount).toBe('vault');
    expect(JSON.parse(state.keychainRaw!).accounts['zai:personal.zai'].credential).toBe('zai-key');
    expect(fs.existsSync(path.join(configDir(home), 'vault.json'))).toBe(false);
  });

  it('falls back to the file vault when keychain write fails', async () => {
    state.failGet = true;
    state.failSet = true;
    const store = await import('./secure-store.js');

    await store.setSecret('zai', 'personal.zai', 'zai-key');

    const fileVault = JSON.parse(fs.readFileSync(path.join(configDir(home), 'vault.json'), 'utf8'));
    expect(fileVault.accounts['zai:personal.zai'].credential).toBe('zai-key');
  });

  it('migrates an existing file vault into keychain', async () => {
    const file = path.join(configDir(home), 'vault.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      accounts: { 'zai:personal.zai': { credential: 'file-key', addedAt: '2026-01-01T00:00:00.000Z' } },
    }));

    const store = await import('./secure-store.js');

    await expect(store.getSecret('zai', 'personal.zai')).resolves.toBe('file-key');
    expect(JSON.parse(state.keychainRaw!).accounts['zai:personal.zai'].credential).toBe('file-key');
    expect(fs.existsSync(file)).toBe(false);
  });
});
