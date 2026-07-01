import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  saved: null as null | { provider: string; name: string; value: string },
  account: null as any,
  active: null as null | { provider: string; name: string },
  execCalls: 0,
  execFileCalls: 0,
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    state.execCalls += 1;
    return '';
  }),
  execFileSync: vi.fn((_cmd: string, _args: string[], opts: any) => {
    state.execFileCalls += 1;
    const input = String(opts?.input || '');
    if (input.includes('/api/oauth/profile')) {
      return JSON.stringify({ account: { has_claude_max: true }, organization: { organization_type: 'pro' } }) + '\nASX_HTTP_STATUS:200';
    }
    return JSON.stringify({ five_hour: { utilization: 25 } }) + '\nASX_HTTP_STATUS:200';
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

import {
  claudeCodeAdapter,
  getClaudeCodeOAuthToken,
  isClaudeCodeLongLivedToken,
  normalizeClaudeCodeOAuthToken,
} from './claude-code.js';

describe('claude long-lived token credentials', () => {
  afterEach(() => {
    state.saved = null;
    state.account = null;
    state.active = null;
    state.execCalls = 0;
    state.execFileCalls = 0;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    vi.unstubAllGlobals();
  });

  it('parses long-lived token credentials', () => {
    const raw = JSON.stringify({ type: 'claude-code-oauth-token', token: 'tok' });
    expect(isClaudeCodeLongLivedToken(raw)).toBe(true);
    expect(getClaudeCodeOAuthToken(raw)).toBe('tok');
    expect(getClaudeCodeOAuthToken(JSON.stringify({ claudeAiOauth: { accessToken: 'oauth' } }))).toBe('oauth');
  });

  it('normalizes setup-token export snippets', () => {
    expect(normalizeClaudeCodeOAuthToken('export CLAUDE_CODE_OAUTH_TOKEN="tok"')).toBe('tok');
    expect(getClaudeCodeOAuthToken(JSON.stringify({ type: 'claude-code-oauth-token', token: 'CLAUDE_CODE_OAUTH_TOKEN=tok' }))).toBe('tok');
  });

  it('stores a long-lived token without native keychain credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ email: 'claude@example.com' }),
    })));

    await claudeCodeAdapter.loadLongLivedToken!('acct.claude', ' long-token ');

    expect(state.saved).toEqual({
      provider: 'claude',
      name: 'acct.claude',
      value: JSON.stringify({ type: 'claude-code-oauth-token', token: 'long-token' }),
    });
    expect(state.account?.email).toBe('claude@example.com');
  });

  it('loads CLAUDE_CODE_OAUTH_TOKEN as a long-lived token account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token';

    await claudeCodeAdapter.loadCurrent('env.claude');

    expect(state.saved).toEqual({
      provider: 'claude',
      name: 'env.claude',
      value: JSON.stringify({ type: 'claude-code-oauth-token', token: 'env-token' }),
    });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('switches long-lived token accounts without writing native credentials', async () => {
    state.saved = {
      provider: 'claude',
      name: 'acct.claude',
      value: JSON.stringify({ type: 'claude-code-oauth-token', token: 'long-token' }),
    };

    await claudeCodeAdapter.switchTo('acct.claude');

    expect(state.active).toEqual({ provider: 'claude', name: 'acct.claude' });
    expect(state.execCalls).toBe(0);
  });

  it('falls back to curl for usage when fetch fails', async () => {
    state.saved = {
      provider: 'claude',
      name: 'acct.claude',
      value: JSON.stringify({ type: 'claude-code-oauth-token', token: 'long-token' }),
    };
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));

    const usage = await claudeCodeAdapter.getUsage!('acct.claude');

    expect(usage).toContain('5h:');
    expect(usage).toContain('75.0% / 25.0%');
    expect(state.execFileCalls).toBe(2);
  });
});
