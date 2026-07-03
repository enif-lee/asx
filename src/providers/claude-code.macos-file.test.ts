import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression tests for macOS Claude Code auth: default homes may use the base
// Keychain service or a file fallback, while CLAUDE_CONFIG_DIR homes use the
// hashed profile-specific Keychain service.

const state = vi.hoisted(() => ({
  saved: null as null | { provider: string; name: string; value: string },
  account: null as any,
  active: null as null | { provider: string; name: string },
  files: new Map<string, string>(),
  keychain: new Map<string, string>(),
  keychainReads: [] as string[],
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
  execSync: vi.fn((_cmd: string) => {
    return '';
  }),
  execFileSync: vi.fn((cmd: string, args: string[], _opts: any) => {
    if (cmd === 'security') {
      const service = args[args.indexOf('-s') + 1];
      state.keychainReads.push(service);
      if (args[0] === 'find-generic-password') {
        const value = state.keychain.get(service);
        if (!value) throw new Error('item not found');
        return value;
      }
      if (args[0] === 'add-generic-password') {
        state.keychain.set(service, args[args.indexOf('-w') + 1]);
        return '';
      }
      if (args[0] === 'delete-generic-password') {
        state.keychain.delete(service);
        return '';
      }
    }
    return 'HTTP/2 200\r\n\r\n' + JSON.stringify({}) + '\nASX_HTTP_STATUS:200';
  }),
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
import { getClaudeKeychainService } from '../utils/claude-keychain.js';

const CREDS_PATH = '/Users/tester/.claude/.credentials.json';
const RAW = JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } });

describe('claude credentials on macOS file-based store', () => {
  afterEach(() => {
    state.saved = null;
    state.account = null;
    state.active = null;
    state.files.clear();
    state.keychain.clear();
    state.keychainReads = [];
    state.written = [];
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CONFIG_DIR;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('loads credentials from ~/.claude/.credentials.json when the Keychain is empty', async () => {
    state.files.set(CREDS_PATH, RAW);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ email: 'file@example.com' }), { status: 200 })));

    await claudeCodeAdapter.loadCurrent('acct.claude');

    expect(state.saved).toEqual({ provider: 'claude', name: 'acct.claude', value: RAW });
    expect(state.account?.email).toBe('file@example.com');
  });

  it('still fails cleanly when neither Keychain nor file has credentials', async () => {
    // no file present
    await expect(claudeCodeAdapter.loadCurrent('acct.claude')).rejects.toThrow(/No active Claude Code credentials/);
  });

  it('loads credentials from the profile-specific Keychain during profile-scoped login', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/Users/tester/.claude';
    state.keychain.set(getClaudeKeychainService('/Users/tester/.claude'), RAW);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ email: 'scoped@example.com' }), { status: 200 })));

    await claudeCodeAdapter.loadCurrent('acct.claude');

    expect(state.saved).toEqual({ provider: 'claude', name: 'acct.claude', value: RAW });
    expect(state.account?.email).toBe('scoped@example.com');
  });

  it('does not fall back to global Keychain during profile-scoped login', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/Users/tester/.claude';
    state.keychain.set(getClaudeKeychainService(), JSON.stringify({ claudeAiOauth: { accessToken: 'stale-keychain-token' } }));

    await expect(claudeCodeAdapter.loadCurrent('acct.claude')).rejects.toThrow(/No active Claude Code credentials/);

    expect(state.keychainReads).not.toContain(getClaudeKeychainService());
    expect(state.saved).toBeNull();
  });

  it('rejects scoped login when local account metadata and token profile differ', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/Users/tester/.claude';
    state.files.set(CREDS_PATH, RAW);
    state.files.set('/Users/tester/.claude/.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'k-june@callabo.ai' } }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ email: 'e-ed@callabo.ai' }), { status: 200 })));

    await expect(claudeCodeAdapter.loadCurrent('acct.claude')).rejects.toThrow(/scoped login mismatch/);

    expect(state.saved).toBeNull();
  });

  it('writes switched credentials to the default Keychain service', async () => {
    state.files.set(CREDS_PATH, JSON.stringify({ claudeAiOauth: { accessToken: 'old' } }));
    state.saved = { provider: 'claude', name: 'acct.claude', value: RAW };

    await claudeCodeAdapter.switchTo('acct.claude');

    expect(state.active).toEqual({ provider: 'claude', name: 'acct.claude' });
    expect(state.keychain.get(getClaudeKeychainService())).toBe(RAW);
    expect(state.files.get(CREDS_PATH)).not.toBe(RAW);
  });
});
