import { describe, expect, it } from 'vitest';
import { getClaudeKeychainService } from './claude-keychain.js';

describe('Claude macOS keychain service names', () => {
  it('matches Claude Code profile keychain hashing', () => {
    expect(getClaudeKeychainService()).toBe('Claude Code-credentials');
    expect(getClaudeKeychainService('/Users/diranged/.claude-profiles/work/config')).toBe('Claude Code-credentials-6061db4b');
  });
});
