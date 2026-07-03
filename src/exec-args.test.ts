import { describe, expect, it } from 'vitest';
import { parseExecArgs } from './exec-args.js';

describe('parseExecArgs', () => {
  it('consumes cross-session ASX options before forwarding agent args', () => {
    const parsed = parseExecArgs(['--share', 'sessions,skills', '-m', 'glm', 'hello'], { isCross: true, agentProvider: 'codex' });

    expect(parsed.share).toEqual({ provided: true, value: ['sessions', 'skills'] });
    expect(parsed.forwardArgs).toEqual(['-m', 'glm', 'hello']);
  });

  it('treats -s as shared and leaves -- args untouched', () => {
    const parsed = parseExecArgs(['-s', '--', '-s', 'agent-value'], { isCross: true, agentProvider: 'codex' });

    expect(parsed.share).toEqual({ provided: true, value: undefined });
    expect(parsed.forwardArgs).toEqual(['-s', 'agent-value']);
  });

  it('does not consume cross-session options for same-provider exec', () => {
    const parsed = parseExecArgs(['-s', '--share', 'sessions'], { isCross: false, agentProvider: 'codex' });

    expect(parsed.share).toEqual({ provided: false });
    expect(parsed.forwardArgs).toEqual(['-s', '--share', 'sessions']);
  });

  it('supports isolate and rejects conflicting or unsupported share options', () => {
    expect(parseExecArgs(['--isolate', 'settings'], { isCross: true, agentProvider: 'codex' }).share)
      .toEqual({ provided: true, value: ['sessions', 'skills'] });

    expect(() => parseExecArgs(['-i', '--share', 'sessions'], { isCross: true, agentProvider: 'codex' }))
      .toThrow(/Use only one/);
    expect(() => parseExecArgs(['--share', 'agents'], { isCross: true, agentProvider: 'codex' }))
      .toThrow(/codex does not support/);
    expect(() => parseExecArgs(['--share'], { isCross: true, agentProvider: 'codex' }))
      .toThrow(/requires categories/);
  });
});
