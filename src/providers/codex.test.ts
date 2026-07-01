import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  stored: JSON.stringify({ tokens: { access_token: 'expired', refresh_token: 'refresh' } }),
  refreshed: JSON.stringify({ email: 'fresh@example.com', tokens: { access_token: 'fresh', refresh_token: 'refresh' } }),
  saved: null as string | null,
  calls: [] as Array<{ cmd: string; envHome?: string }>,
}));

vi.mock('node:child_process', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    execSync: vi.fn((cmd: string, opts: any = {}) => {
      state.calls.push({ cmd, envHome: opts.env?.CODEX_HOME });
      if (!opts.env?.CODEX_HOME) throw new Error('missing CODEX_HOME');
      fs.writeFileSync(path.join(opts.env.CODEX_HOME, 'auth.json'), state.refreshed);
      return '';
    }),
  };
});

vi.mock('../storage/secure-store.js', () => ({
  getSecret: vi.fn(async () => state.stored),
  setSecret: vi.fn(async (_provider: string, _name: string, value: string) => {
    state.saved = value;
  }),
}));

vi.mock('../storage/account-store.js', () => ({
  addAccount: vi.fn(),
}));

import { codexAdapter } from './codex.js';

describe('codex refresh isolation', () => {
  afterEach(() => {
    state.saved = null;
    state.calls = [];
  });

  it('refreshes in a temporary CODEX_HOME without mutating another current profile', async () => {
    const prev = process.env.CODEX_HOME;
    const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-codex-shared-'));
    const sharedAuth = path.join(sharedHome, 'auth.json');
    fs.writeFileSync(sharedAuth, 'shared');
    process.env.CODEX_HOME = sharedHome;

    try {
      const result = await codexAdapter.refresh!('acct');

      expect(result.ok).toBe(true);
      expect(state.saved).toBe(state.refreshed);
      expect(fs.readFileSync(sharedAuth, 'utf8')).toBe('shared');
      expect(state.calls).toHaveLength(1);
      expect(state.calls[0].cmd).toBe('codex doctor --summary');
      expect(state.calls[0].envHome).toContain('asx-codex-refresh-acct-');
      expect(state.calls[0].envHome).not.toBe(sharedHome);
      expect(state.calls[0].envHome && fs.existsSync(state.calls[0].envHome)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
      fs.rmSync(sharedHome, { recursive: true, force: true });
    }
  });

  it('syncs the shared CODEX_HOME when it is the refreshed profile', async () => {
    const prev = process.env.CODEX_HOME;
    const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-codex-shared-'));
    const sharedAuth = path.join(sharedHome, 'auth.json');
    fs.writeFileSync(sharedAuth, state.stored);
    process.env.CODEX_HOME = sharedHome;

    try {
      const result = await codexAdapter.refresh!('acct');

      expect(result.ok).toBe(true);
      expect(state.saved).toBe(state.refreshed);
      expect(fs.readFileSync(sharedAuth, 'utf8')).toBe(state.refreshed);
      expect(state.calls[0].envHome).not.toBe(sharedHome);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
      fs.rmSync(sharedHome, { recursive: true, force: true });
    }
  });
});
