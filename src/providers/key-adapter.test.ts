import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  saved: null as null | { provider: string; name: string; value: string },
  account: null as any,
  active: null as null | { provider: string; name: string },
}));

vi.mock('../storage/secure-store.js', () => ({
  setSecret: vi.fn(async (provider: string, name: string, value: string) => {
    state.saved = { provider, name, value };
  }),
  getSecret: vi.fn(async (provider: string, name: string) => {
    if (state.saved?.provider === provider && state.saved?.name === name) return state.saved.value;
    return null;
  }),
}));

vi.mock('../storage/account-store.js', () => ({
  addAccount: vi.fn((account: any) => {
    state.account = account;
  }),
  setActive: vi.fn((provider: string, name: string) => {
    state.active = { provider, name };
  }),
}));

import { createKeyAdapter } from './key-adapter.js';

describe('grok home', () => {
  afterEach(() => {
    state.saved = null;
    state.account = null;
    state.active = null;
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
        value: JSON.stringify({ issuer: { key: 'jwt-token', email: 'g@example.com' } }),
      });
      expect(state.account?.email).toBe('g@example.com');
      await expect(createKeyAdapter('grok').getCurrentCredential?.()).resolves.toBe(JSON.stringify({ issuer: { key: 'jwt-token', email: 'g@example.com' } }));
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('supports native Grok login command', () => {
    expect(createKeyAdapter('grok').getLoginCommand?.()).toEqual(['grok', 'login']);
  });

  it('switches Grok auth into GROK_HOME', async () => {
    const prev = process.env.GROK_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-grok-home-'));
    process.env.GROK_HOME = home;
    state.saved = {
      provider: 'grok',
      name: 'acct',
      value: JSON.stringify({ issuer: { key: 'jwt-token', email: 'g@example.com' } }),
    };

    try {
      await createKeyAdapter('grok').switchTo('acct');

      const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
      expect(auth).toEqual({ issuer: { key: 'jwt-token', email: 'g@example.com' } });
      expect(state.active).toEqual({ provider: 'grok', name: 'acct' });
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('clears Grok auth from GROK_HOME', async () => {
    const prev = process.env.GROK_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-grok-home-'));
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ issuer: { key: 'jwt-token' } }));
    process.env.GROK_HOME = home;

    try {
      await createKeyAdapter('grok').clearCurrent?.();

      expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('loads ZAI auth from ZAI_API_KEY', async () => {
    const prev = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = 'zai-key';

    try {
      await createKeyAdapter('zai').loadCurrent('acct');

      expect(state.saved).toEqual({ provider: 'zai', name: 'acct', value: 'zai-key' });
      expect(state.account?.name).toBe('acct');
    } finally {
      if (prev === undefined) delete process.env.ZAI_API_KEY;
      else process.env.ZAI_API_KEY = prev;
    }
  });

  it('logs in ZAI with API key and tests the endpoint', async () => {
    const prev = process.env.ASX_ZAI_API_KEY;
    process.env.ASX_ZAI_API_KEY = 'zai-key';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    try {
      await createKeyAdapter('zai').login?.('acct');

      expect(fetchSpy).toHaveBeenCalledWith('https://api.z.ai/api/coding/paas/v4/models', expect.any(Object));
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect((init.headers as any).Authorization).toBe('Bearer zai-key');
      expect(state.saved).toEqual({ provider: 'zai', name: 'acct', value: 'zai-key' });
      expect(state.active).toEqual({ provider: 'zai', name: 'acct' });
    } finally {
      fetchSpy.mockRestore();
      if (prev === undefined) delete process.env.ASX_ZAI_API_KEY;
      else process.env.ASX_ZAI_API_KEY = prev;
    }
  });

  it('rejects ZAI login when endpoint test fails', async () => {
    const prev = process.env.ASX_ZAI_API_KEY;
    process.env.ASX_ZAI_API_KEY = 'bad-key';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad key', { status: 401, statusText: 'Unauthorized' }));

    try {
      await expect(createKeyAdapter('zai').login?.('acct')).rejects.toThrow('ZAI endpoint test failed (401 Unauthorized: bad key)');
      expect(state.saved).toBeNull();
      expect(state.account).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      if (prev === undefined) delete process.env.ASX_ZAI_API_KEY;
      else process.env.ASX_ZAI_API_KEY = prev;
    }
  });
});
