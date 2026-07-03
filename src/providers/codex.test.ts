import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      // Native Codex refreshes auth.json in place inside its CODEX_HOME.
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

function configDir(home: string): string {
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'asx');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'asx');
  return path.join(home, '.config', 'asx');
}

describe('codex refresh (in-place, profile home is the SSOT)', () => {
  let home: string;
  let profileHome: string;
  let prevHome: string | undefined;
  let prevAppData: string | undefined;
  let prevXdg: string | undefined;
  let prevCodexHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-codex-'));
    prevHome = process.env.HOME;
    prevAppData = process.env.APPDATA;
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevCodexHome = process.env.CODEX_HOME;
    process.env.HOME = home;
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    // Simulate a stored account: the profile home already holds the credential.
    profileHome = path.join(configDir(home), 'profiles', 'codex-acct');
    fs.mkdirSync(profileHome, { recursive: true });
    fs.writeFileSync(path.join(profileHome, 'auth.json'), state.stored);
  });

  afterEach(() => {
    state.saved = null;
    state.calls = [];
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('refreshes in the profile home and leaves an unrelated shared default untouched', async () => {
    const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-codex-shared-'));
    const sharedAuth = path.join(sharedHome, 'auth.json');
    fs.writeFileSync(sharedAuth, 'shared'); // different from the stored profile cred
    process.env.CODEX_HOME = sharedHome;

    try {
      const result = await codexAdapter.refresh!('acct');

      expect(result.ok).toBe(true);
      // Refresh happened in the profile home (the SSOT), not a temp dir.
      expect(state.calls).toHaveLength(1);
      expect(state.calls[0].cmd).toBe('codex doctor --summary');
      expect(state.calls[0].envHome).toBe(profileHome);
      expect(fs.readFileSync(path.join(profileHome, 'auth.json'), 'utf8')).toBe(state.refreshed);
      // The unrelated shared default is left alone.
      expect(fs.readFileSync(sharedAuth, 'utf8')).toBe('shared');
    } finally {
      fs.rmSync(sharedHome, { recursive: true, force: true });
    }
  });

  it('also updates the shared default when it holds the same (now stale) credential', async () => {
    const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-codex-shared-'));
    const sharedAuth = path.join(sharedHome, 'auth.json');
    fs.writeFileSync(sharedAuth, state.stored); // matches the profile's old cred
    process.env.CODEX_HOME = sharedHome;

    try {
      const result = await codexAdapter.refresh!('acct');

      expect(result.ok).toBe(true);
      expect(fs.readFileSync(path.join(profileHome, 'auth.json'), 'utf8')).toBe(state.refreshed);
      expect(fs.readFileSync(sharedAuth, 'utf8')).toBe(state.refreshed);
    } finally {
      fs.rmSync(sharedHome, { recursive: true, force: true });
    }
  });
});
