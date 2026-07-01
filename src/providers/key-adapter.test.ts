import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  saved: null as null | { provider: string; name: string; value: string },
  account: null as any,
}));

vi.mock('../storage/secure-store.js', () => ({
  setSecret: vi.fn(async (provider: string, name: string, value: string) => {
    state.saved = { provider, name, value };
  }),
  getSecret: vi.fn(async () => null),
}));

vi.mock('../storage/account-store.js', () => ({
  addAccount: vi.fn((account: any) => {
    state.account = account;
  }),
}));

import { createKeyAdapter } from './key-adapter.js';

describe('grok home', () => {
  afterEach(() => {
    state.saved = null;
    state.account = null;
  });

  it('loads Grok auth from GROK_HOME', async () => {
    const prev = process.env.GROK_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-grok-home-'));
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ issuer: { key: 'jwt-token', email: 'g@example.com' } }));
    process.env.GROK_HOME = home;

    try {
      await createKeyAdapter('grok').loadCurrent('acct');

      expect(state.saved).toEqual({
        provider: 'grok',
        name: 'acct',
        value: JSON.stringify({ key: 'jwt-token', email: 'g@example.com' }),
      });
      expect(state.account?.email).toBe('g@example.com');
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
