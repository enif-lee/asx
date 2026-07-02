import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression tests for macOS setups where Claude Code stores its credentials in
// ~/.claude/.credentials.json instead of the login Keychain. asx must fall back to
// that file for both `load` (read) and `switch` (write); otherwise `asx load claude`
// fails with "No active Claude Code credentials found" for a logged-in user.

const state = vi.hoisted(() => ({
  saved: null as null | { provider: string; name: string; value: string },
  account: null as any,
  active: null as null | { provider: string; name: string },
  files: new Map<string, string>(),
  keychain: null as string | null,
  written: [] as Array<{ path: string; data: string }>,
}));

vi.mock('../utils/platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/platform.js')>();
  return {
    ...actual,
    getPlatform: () => 'darwin' as const,
    getClaudeCredentialsPath: () => '/Users/tester/.claude/.credentials.json',
    ensureDirFor: () => {},
  };
});

vi.mock('node:fs', () => ({
  default: {
    existsSync: (p: string) => state.files.has(String(p)),
    readFileSync: (p: string) => {
      const v = state.files.get(String(p));
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    writeFileSync: (p: string, data: string) => {
      state.files.set(String(p), String(data));
      state.written.push({ path: String(p), data: String(data) });
    },
    chmodSync: () => {},
  },
}));

vi.mock('node:child_process', () => ({
  // Keychain miss for reads (throws), no-op for writes.
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('find-generic-password')) {
      if (state.keychain === null) throw new Error('item not found');
      return state.keychain;
    }
    return '';
  }),
  execFileSync: vi.fn(() => 'HTTP/2 200\r\n\r\n' + JSON.stringify({}) + '\nASX_HTTP_STATUS:200'),
}));

vi.mock('../storage/secure-store.js', () => ({
  setSecret: vi.fn(async (provider: string, name: string, value: string) => {
    state.saved = { provider, name, value };
  }),
  getSecret: vi.fn(async () => state.saved?.value ?? null),
}));

vi.mock('../storage/account-store.js', () => ({
  addAccount: vi.fn((account: any) => {
    state.account = account;
  }),
  setActive: vi.fn((provider: string, name: string) => {
    state.active = { provider, name };
  }),
}));

import { claudeCodeAdapter } from './claude-code.js';

const CREDS_PATH = '/Users/tester/.claude/.credentials.json';
const RAW = JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } });

describe('claude credentials on macOS file-based store', () => {
  afterEach(() => {
    state.saved = null;
    state.account = null;
    state.active = null;
    state.files.clear();
    state.keychain = null;
    state.written = [];
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('loads credentials from ~/.claude/.credentials.json when the Keychain is empty', async () => {
    state.keychain = null; // keychain miss
    state.files.set(CREDS_PATH, RAW);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ email: 'file@example.com' }), { status: 200 })));

    await claudeCodeAdapter.loadCurrent('acct.claude');

    expect(state.saved).toEqual({ provider: 'claude', name: 'acct.claude', value: RAW });
    expect(state.account?.email).toBe('file@example.com');
  });

  it('still fails cleanly when neither Keychain nor file has credentials', async () => {
    state.keychain = null;
    // no file present
    await expect(claudeCodeAdapter.loadCurrent('acct.claude')).rejects.toThrow(/No active Claude Code credentials/);
  });

  it('mirrors switched credentials to the file when a file-based store exists', async () => {
    state.files.set(CREDS_PATH, JSON.stringify({ claudeAiOauth: { accessToken: 'old' } }));
    state.saved = { provider: 'claude', name: 'acct.claude', value: RAW };

    await claudeCodeAdapter.switchTo('acct.claude');

    expect(state.active).toEqual({ provider: 'claude', name: 'acct.claude' });
    expect(state.files.get(CREDS_PATH)).toBe(RAW);
    expect(state.written.some((w) => w.path === CREDS_PATH && w.data === RAW)).toBe(true);
  });
});
