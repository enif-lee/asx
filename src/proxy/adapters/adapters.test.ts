import { describe, it, expect, afterEach } from 'vitest';
import { grokAgent, grokBackend } from './grok.js';
import { codexAgent, codexBackend } from './codex.js';
import { claudeAgent, claudeBackend } from './claude.js';
import { zaiBackend, isZaiOverload } from './zai.js';
import { clearRemoteModelCache, refreshBackendChoices } from '../models.js';
import type { StreamCtx, CommonEvent } from '../types.js';

afterEach(() => clearRemoteModelCache());

const ctx = (model = 'm'): StreamCtx => ({ id: 'id1', created: 1, model, first: true });
const stream = (a: any, evs: CommonEvent[]) => {
  const c = ctx();
  return evs.map((e) => a.formatStreamChunk(e, c)).join('');
};

describe('grok agent (chat completions wire)', () => {
  it('parses system + messages into COMMON', () => {
    const r = grokAgent.parseRequest('/v1/chat/completions', {
      model: 'x', stream: true,
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    });
    expect(r.system).toBe('sys');
    expect(r.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(r.stream).toBe(true);
  });
  it('array content is flattened to text', () => {
    const r = grokAgent.parseRequest('/x', { messages: [{ role: 'user', content: [{ text: 'a' }, { text: 'b' }] }] });
    expect(r.messages[0].content).toBe('ab');
  });
  it('stream chunk has required chat.completion.chunk fields + [DONE]', () => {
    const out = stream(grokAgent, [{ type: 'text', text: 'hi' }, { type: 'done' }]);
    expect(out).toContain('"object":"chat.completion.chunk"');
    expect(out).toContain('"created":1');
    expect(out).toContain('"content":"hi"');
    expect(out).toContain('data: [DONE]');
  });
  it('done-only (no text) still terminates with [DONE]', () => {
    const out = stream(grokAgent, [{ type: 'done' }]);
    expect(out).toContain('data: [DONE]');
  });
});

describe('codex backend (Responses wire)', () => {
  it('folds system into instructions, never role=system in input', () => {
    const { body } = codexBackend.buildRequest(
      { model: 'gpt-5.5-high', system: 'S', messages: [{ role: 'system', content: 'extra' }, { role: 'user', content: 'hi' }], stream: true } as any,
      JSON.stringify({ tokens: { access_token: 't', account_id: 'a' } }),
    );
    const b = JSON.parse(body);
    expect(b.instructions).toContain('S');
    expect(b.input.every((m: any) => m.role !== 'system')).toBe(true);
  });
  it('maps the picked choice id to model + effort', () => {
    const { body } = codexBackend.buildRequest({ model: 'gpt-5.6-sol-xhigh', messages: [], stream: true } as any, '{}');
    const b = JSON.parse(body);
    expect(b.model).toBe('gpt-5.6-sol');
    expect(b.reasoning.effort).toBe('xhigh');
  });
  it('maps terra/luna choice ids to the correct upstream model strings', () => {
    const terra = JSON.parse(codexBackend.buildRequest(
      { model: 'gpt-5.6-terra-high', messages: [], stream: true } as any, '{}',
    ).body);
    expect(terra.model).toBe('gpt-5.6-terra');
    expect(terra.reasoning.effort).toBe('high');
    const luna = JSON.parse(codexBackend.buildRequest(
      { model: 'gpt-5.6-luna-max', messages: [], stream: true } as any, '{}',
    ).body);
    expect(luna.model).toBe('gpt-5.6-luna');
    expect(luna.reasoning.effort).toBe('max');
    // 5.5 still resolves for backward compat
    const legacy = JSON.parse(codexBackend.buildRequest(
      { model: 'gpt-5.5-low', messages: [], stream: true } as any, '{}',
    ).body);
    expect(legacy.model).toBe('gpt-5.5');
    expect(legacy.reasoning.effort).toBe('low');
  });
  it('extractAuth tolerates a bare token (no JSON)', () => {
    const { headers } = codexBackend.buildRequest({ model: 'x', messages: [], stream: true } as any, 'bare-token');
    expect(headers.Authorization).toBe('Bearer bare-token');
  });
  it('parseStreamChunk pulls text delta and done', () => {
    const evs = codexBackend.parseStreamChunk('data: {"type":"response.output_text.delta","delta":"hi"}\ndata: {"type":"response.completed"}');
    expect(evs).toEqual([{ type: 'text', text: 'hi' }, { type: 'done', finishReason: 'stop' }]);
  });
});

describe('codex agent (Responses wire out)', () => {
  it('done-only response still emits opening events then completes', () => {
    const out = stream(codexAgent, [{ type: 'done' }]);
    expect(out).toContain('response.created');
    expect(out).toContain('response.output_item.added');
    expect(out).toContain('response.completed');
  });
});

describe('claude backend (Messages wire)', () => {
  it('first system block is the Claude Code identity + Bearer oauth', () => {
    const { headers, body, url } = claudeBackend.buildRequest(
      { model: 'claude-opus-4-8', system: 'real', messages: [{ role: 'user', content: 'hi' }], stream: true } as any,
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }),
    );
    const b = JSON.parse(body);
    expect(b.system[0].text).toContain('Claude Code');
    expect(headers.authorization).toBe('Bearer tok');
    expect(url).toContain('beta=true');
  });
  it('accepts long-lived token credentials', () => {
    const { headers } = claudeBackend.buildRequest(
      { model: 'claude-opus-4-8', messages: [], stream: true } as any,
      JSON.stringify({ type: 'claude-code-oauth-token', token: 'long-token' }),
    );
    expect(headers.authorization).toBe('Bearer long-token');
  });
});

describe('claude agent done-only', () => {
  it('opens then closes the message even with no text', () => {
    const out = stream(claudeAgent, [{ type: 'done' }]);
    expect(out).toContain('message_start');
    expect(out).toContain('content_block_start');
    expect(out).toContain('message_stop');
  });
});

describe('zai backend (OpenAI chat completions)', () => {
  it('uses the coding endpoint and maps model ids', () => {
    const { url, headers, body } = zaiBackend.buildRequest(
      { model: 'glm-5.2[1m]', system: 'S', messages: [{ role: 'user', content: 'hi' }], stream: true } as any,
      'zai-key',
    );
    const b = JSON.parse(body);
    expect(url).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
    expect(headers.Authorization).toBe('Bearer zai-key');
    expect(b.model).toBe('glm-5.2[1m]');
    expect(b.messages[0]).toEqual({ role: 'system', content: 'S' });
  });

  it('forwards thinking for an effort-bearing model, omits it for glm-4.5-air', () => {
    const withEffort = JSON.parse(zaiBackend.buildRequest(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true } as any, 'k',
    ).body);
    expect(withEffort.thinking).toEqual({ type: 'enabled' });

    const air = JSON.parse(zaiBackend.buildRequest(
      { model: 'glm-4.5-air', messages: [{ role: 'user', content: 'hi' }], stream: true } as any, 'k',
    ).body);
    expect(air.thinking).toBeUndefined();
  });

  it('flags z.ai overload codes/messages as retryable', () => {
    expect(isZaiOverload('{"error":{"code":"1305","message":"overloaded"}}')).toBe(true);
    expect(zaiBackend.isRetryable!(200, '{"error":{"code":"1305"}}')).toBe(true);
    expect(isZaiOverload('{"choices":[]}')).toBe(false);
  });
});
