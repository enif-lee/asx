import { describe, it, expect } from 'vitest';
import { grokAgent, grokBackend } from './grok.js';
import { codexAgent, codexBackend } from './codex.js';
import { claudeAgent, claudeBackend } from './claude.js';
import { zaiBackend } from './zai.js';
import { toolAccumulator } from '../server.js';
import type { StreamCtx, CommonEvent } from '../types.js';

const ctx = (model = 'm'): StreamCtx => ({ id: 'id1', created: 1, model, first: true });
const stream = (a: any, evs: CommonEvent[]) => {
  const c = ctx();
  return evs.map((e) => a.formatStreamChunk(e, c)).join('');
};
// Parse SSE text back into event objects for assertions.
const sseObjects = (s: string) =>
  s.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
    .filter((p) => p && p !== '[DONE]').map((p) => JSON.parse(p));

// A complete tool_call event, as the proxy server hands it to an agent adapter.
const CALL: CommonEvent = { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: '{"city":"seoul"}' };

describe('formatModels (per-agent /model picker schema)', () => {
  const choices = [{ id: 'claude-opus-4-8', model: 'claude-opus-4-8' }, { id: 'claude-sonnet-4-6', model: 'claude-sonnet-4-6' }];
  it('codex returns { models: ModelInfo[] } with all required fields', () => {
    const out: any = codexAgent.formatModels(choices);
    expect(Array.isArray(out.models)).toBe(true);
    const m = out.models[0];
    // required (no serde default) fields codex 0.142.x rejects the body without
    for (const f of ['slug', 'display_name', 'supported_reasoning_levels', 'shell_type', 'visibility',
      'supported_in_api', 'priority', 'base_instructions', 'supports_reasoning_summaries',
      'support_verbosity', 'truncation_policy', 'supports_parallel_tool_calls', 'experimental_supported_tools']) {
      expect(m, `missing ${f}`).toHaveProperty(f);
    }
    expect(m.slug).toBe('claude-opus-4-8');
    expect(m.truncation_policy).toEqual({ mode: 'tokens', limit: 10000 });
    expect(m.supported_reasoning_levels[0]).toHaveProperty('effort');
  });
  it('claude returns Anthropic models list shape', () => {
    const out: any = claudeAgent.formatModels(choices);
    expect(out.has_more).toBe(false);
    expect(out.data[0]).toEqual({ id: 'claude-opus-4-8', type: 'model', display_name: 'claude-opus-4-8', created_at: '2025-01-01T00:00:00Z' });
    expect(out.first_id).toBe('claude-opus-4-8');
    expect(out.last_id).toBe('claude-sonnet-4-6');
  });
  it('claude wraps non-claude backend ids so they survive the /model filter, and unwraps on request', () => {
    const out: any = claudeAgent.formatModels([{ id: 'gpt-5.5-high', model: 'gpt-5.5', effort: 'high' }, { id: 'glm-5.2', model: 'glm-5.2' }]);
    // ids must start with claude/anthropic (Claude Code drops any that don't)
    expect(out.data.every((m: any) => /^(claude|anthropic)/i.test(m.id))).toBe(true);
    // display_name keeps the real name the user sees
    expect(out.data[0].display_name).toBe('gpt-5.5-high');
    // and the wrapped id round-trips back to the real backend id on a request
    const r = claudeAgent.parseRequest('/v1/messages', { model: out.data[0].id, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.model).toBe('gpt-5.5-high');
  });
  it('grok returns OpenAI list shape', () => {
    const out: any = grokAgent.formatModels(choices);
    expect(out.object).toBe('list');
    expect(out.data[0]).toMatchObject({ id: 'claude-opus-4-8', object: 'model' });
  });
});

describe('server toolAccumulator', () => {
  it('merges id/name/args fragments by index in first-seen order', () => {
    const acc = toolAccumulator();
    acc.push({ index: 0, id: 'c0', name: 'foo' });
    acc.push({ index: 1, id: 'c1', name: 'bar' });
    acc.push({ index: 0, argsDelta: '{"a"' });
    acc.push({ index: 0, argsDelta: ':1}' });
    acc.push({ index: 1, argsDelta: '{}' });
    expect(acc.list()).toEqual([
      { type: 'tool_call', id: 'c0', name: 'foo', arguments: '{"a":1}' },
      { type: 'tool_call', id: 'c1', name: 'bar', arguments: '{}' },
    ]);
  });
  it('clear resets state', () => {
    const acc = toolAccumulator();
    acc.push({ index: 0, id: 'c0', name: 'foo', argsDelta: '{}' });
    acc.clear();
    expect(acc.list()).toEqual([]);
  });
});

describe('codex agent tools', () => {
  it('parses function tool defs (flat Responses shape)', () => {
    const r = codexAgent.parseRequest('/responses', {
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
    });
    expect(r.tools).toEqual([{ name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } }]);
  });
  it('preserves function_call and function_call_output history (session continuity)', () => {
    const r = codexAgent.parseRequest('/responses', {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"seoul"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      ],
    });
    expect(r.messages).toEqual([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"seoul"}' }] },
      { role: 'tool', content: 'sunny', toolCallId: 'call_1' },
    ]);
  });
  it('folds the codex "developer" role into system (real codex sends it; Anthropic rejects it)', () => {
    const r = codexAgent.parseRequest('/responses', {
      instructions: 'base',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'be terse' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    });
    expect(r.messages.every((m) => m.role !== 'developer')).toBe(true);
    expect(r.system).toContain('be terse');
    // and the claude backend must never emit a non-user/assistant role
    const { body } = claudeBackend.buildRequest(r as any, 'tok');
    expect(JSON.parse(body).messages.every((m: any) => m.role === 'user' || m.role === 'assistant')).toBe(true);
  });
  it('emits a well-formed function_call item sequence', () => {
    const out = stream(codexAgent, [CALL, { type: 'done' }]);
    expect(out).toContain('response.output_item.added');
    expect(out).toContain('response.function_call_arguments.delta');
    expect(out).toContain('response.function_call_arguments.done');
    const objs = sseObjects(out);
    const done = objs.find((o) => o.type === 'response.output_item.done' && o.item?.type === 'function_call');
    expect(done.item).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"seoul"}' });
    const completed = objs.find((o) => o.type === 'response.completed');
    expect(completed.response.output.some((i: any) => i.type === 'function_call')).toBe(true);
  });
  it('interleaves text then tool call at distinct output indices', () => {
    const out = stream(codexAgent, [{ type: 'text', text: 'hmm' }, CALL, { type: 'done' }]);
    const objs = sseObjects(out);
    const added = objs.filter((o) => o.type === 'response.output_item.added');
    expect(added[0].output_index).toBe(0);         // text message
    expect(added[1].output_index).toBe(1);         // function call
  });
});

describe('codex backend tools', () => {
  it('sends function tools in Responses shape', () => {
    const { body } = codexBackend.buildRequest(
      { model: 'gpt-5.5-low', messages: [{ role: 'user', content: 'hi' }], stream: true,
        tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }] } as any,
      '{}',
    );
    const b = JSON.parse(body);
    expect(b.tools).toEqual([{ type: 'function', name: 'get_weather', description: 'w', parameters: { type: 'object' }, strict: false }]);
  });
  it('serializes assistant tool calls + tool results into input', () => {
    const { body } = codexBackend.buildRequest(
      { model: 'gpt-5.5-low', stream: true, messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"seoul"}' }] },
        { role: 'tool', content: 'sunny', toolCallId: 'call_1' },
      ] } as any,
      '{}',
    );
    const b = JSON.parse(body);
    expect(b.input).toContainEqual({ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"seoul"}' });
    expect(b.input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: 'sunny' });
  });
  it('parses streamed function_call fragments into tool_call_delta', () => {
    const evs = codexBackend.parseStreamChunk(
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"get_weather"}}\n' +
      'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"city\\":"}\n' +
      'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"\\"seoul\\"}"}',
    );
    expect(evs).toEqual([
      { type: 'tool_call_delta', index: 1, id: 'call_1', name: 'get_weather', argsDelta: undefined },
      { type: 'tool_call_delta', index: 1, argsDelta: '{"city":' },
      { type: 'tool_call_delta', index: 1, argsDelta: '"seoul"}' },
    ]);
  });
});

describe('claude agent tools', () => {
  it('parses tools (input_schema -> parameters)', () => {
    const r = claudeAgent.parseRequest('/v1/messages', {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }],
    });
    expect(r.tools).toEqual([{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }]);
  });
  it('preserves tool_use and tool_result history', () => {
    const r = claudeAgent.parseRequest('/v1/messages', {
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: [{ type: 'text', text: 'let me check' }, { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'seoul' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny' }] },
      ],
    });
    expect(r.messages).toEqual([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: 'let me check', toolCalls: [{ id: 'tu_1', name: 'get_weather', arguments: '{"city":"seoul"}' }] },
      { role: 'tool', content: 'sunny', toolCallId: 'tu_1' },
    ]);
  });
  it('emits a tool_use block and stop_reason=tool_use', () => {
    const out = stream(claudeAgent, [CALL, { type: 'done' }]);
    const objs = sseObjects(out);
    const start = objs.find((o) => o.type === 'content_block_start' && o.content_block?.type === 'tool_use');
    expect(start.content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'get_weather' });
    const jsonDelta = objs.find((o) => o.type === 'content_block_delta' && o.delta?.type === 'input_json_delta');
    expect(jsonDelta.delta.partial_json).toBe('{"city":"seoul"}');
    const md = objs.find((o) => o.type === 'message_delta');
    expect(md.delta.stop_reason).toBe('tool_use');
  });
});

describe('claude backend tools', () => {
  it('sends tools (parameters -> input_schema)', () => {
    const { body } = claudeBackend.buildRequest(
      { model: 'claude-opus-4-8', stream: true, messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }] } as any,
      'tok',
    );
    const b = JSON.parse(body);
    expect(b.tools).toEqual([{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }]);
  });
  it('rebuilds tool_use / tool_result blocks and parses input JSON', () => {
    const { body } = claudeBackend.buildRequest(
      { model: 'claude-opus-4-8', stream: true, messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: 'checking', toolCalls: [{ id: 'tu_1', name: 'get_weather', arguments: '{"city":"seoul"}' }] },
        { role: 'tool', content: 'sunny', toolCallId: 'tu_1' },
      ] } as any,
      'tok',
    );
    const b = JSON.parse(body);
    const asst = b.messages.find((m: any) => m.role === 'assistant');
    expect(asst.content).toContainEqual({ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'seoul' } });
    const toolTurn = b.messages.find((m: any) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
    expect(toolTurn).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny' }] });
  });
  it('merges consecutive tool results into one user turn', () => {
    const { body } = claudeBackend.buildRequest(
      { model: 'claude-opus-4-8', stream: true, messages: [
        { role: 'tool', content: 'a', toolCallId: 't1' },
        { role: 'tool', content: 'b', toolCallId: 't2' },
      ] } as any,
      'tok',
    );
    const b = JSON.parse(body);
    const userTurns = b.messages.filter((m: any) => m.role === 'user');
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0].content).toHaveLength(2);
  });
  it('parses streamed tool_use content blocks into tool_call_delta', () => {
    const evs = claudeBackend.parseStreamChunk(
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}\n' +
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"seoul\\"}"}}',
    );
    expect(evs).toEqual([
      { type: 'tool_call_delta', index: 1, id: 'tu_1', name: 'get_weather' },
      { type: 'tool_call_delta', index: 1, argsDelta: '{"city":"seoul"}' },
    ]);
  });
});

describe('claude backend thinking + sampling safety', () => {
  it('disables extended thinking for non-fable models (avoids tool-loop 400)', () => {
    const { body } = claudeBackend.buildRequest(
      { model: 'claude-opus-4-8', stream: true, messages: [{ role: 'user', content: 'hi' }] } as any, 'tok');
    expect(JSON.parse(body).thinking).toEqual({ type: 'disabled' });
  });
  it('omits thinking for fable (cannot be disabled there)', () => {
    const prev = process.env.ASX_CLAUDE_MODELS;
    process.env.ASX_CLAUDE_MODELS = 'claude-fable-5'; // register fable so resolveChoice keeps it
    try {
      const { body } = claudeBackend.buildRequest(
        { model: 'claude-fable-5', stream: true, messages: [{ role: 'user', content: 'hi' }] } as any, 'tok');
      expect(JSON.parse(body).thinking).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ASX_CLAUDE_MODELS; else process.env.ASX_CLAUDE_MODELS = prev;
    }
  });
  it('never sends temperature/top_p/top_k (rejected by newer models)', () => {
    const { body } = claudeBackend.buildRequest(
      { model: 'claude-opus-4-8', stream: true, temperature: 0.7, messages: [{ role: 'user', content: 'hi' }] } as any, 'tok');
    const b = JSON.parse(body);
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
    expect(b.top_k).toBeUndefined();
  });
});

describe('tool result / def metadata', () => {
  it('claude round-trips tool_result is_error', () => {
    const r = claudeAgent.parseRequest('/v1/messages', {
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] }],
    });
    expect(r.messages[0]).toMatchObject({ role: 'tool', toolCallId: 't1', isError: true });
    const { body } = claudeBackend.buildRequest({ model: 'claude-opus-4-8', stream: true, messages: r.messages } as any, 'tok');
    const block = JSON.parse(body).messages[0].content[0];
    expect(block).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true });
  });
  it('claude passes built-in tool type through without a synthetic schema', () => {
    const r = claudeAgent.parseRequest('/v1/messages', {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'bash_20250124', name: 'bash' }],
    });
    expect(r.tools).toEqual([{ name: 'bash', description: undefined, parameters: undefined, builtinType: 'bash_20250124' }]);
    const { body } = claudeBackend.buildRequest({ model: 'claude-opus-4-8', stream: true, messages: [], tools: r.tools } as any, 'tok');
    expect(JSON.parse(body).tools[0]).toEqual({ type: 'bash_20250124', name: 'bash' });
  });
  it('codex + chat carry strict and parallel_tool_calls', () => {
    const codex = JSON.parse(codexBackend.buildRequest(
      { model: 'gpt-5.5-low', stream: true, messages: [], parallelToolCalls: true,
        tools: [{ name: 'f', parameters: { type: 'object' }, strict: true }] } as any, '{}').body);
    expect(codex.tools[0].strict).toBe(true);
    expect(codex.parallel_tool_calls).toBe(true);
    const grok = JSON.parse(grokBackend.buildRequest(
      { model: 'grok-code', stream: true, messages: [], parallelToolCalls: false,
        tools: [{ name: 'f', parameters: { type: 'object' }, strict: true }] } as any, 'tok').body);
    expect(grok.tools[0].function.strict).toBe(true);
    expect(grok.parallel_tool_calls).toBe(false);
  });
});

describe('grok agent tools (chat completions)', () => {
  it('parses tools and assistant tool_calls / tool results', () => {
    const r = grokAgent.parseRequest('/v1/chat/completions', {
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }],
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"seoul"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
    });
    expect(r.tools).toEqual([{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }]);
    expect(r.messages).toEqual([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"seoul"}' }] },
      { role: 'tool', content: 'sunny', toolCallId: 'call_1', toolName: undefined },
    ]);
  });
  it('emits delta.tool_calls and finish_reason=tool_calls', () => {
    const out = stream(grokAgent, [CALL, { type: 'done' }]);
    const objs = sseObjects(out);
    const tc = objs.find((o) => o.choices?.[0]?.delta?.tool_calls);
    expect(tc.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"seoul"}' } });
    const fin = objs.find((o) => o.choices?.[0]?.finish_reason);
    expect(fin.choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('grok/zai backend tools (chat completions)', () => {
  it('grok backend sends tools + serializes tool history', () => {
    const { body } = grokBackend.buildRequest(
      { model: 'grok-code', stream: true, messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"seoul"}' }] },
        { role: 'tool', content: 'sunny', toolCallId: 'call_1' },
      ], tools: [{ name: 'get_weather', parameters: { type: 'object' } }] } as any,
      'tok',
    );
    const b = JSON.parse(body);
    expect(b.tools[0]).toMatchObject({ type: 'function', function: { name: 'get_weather' } });
    expect(b.messages).toContainEqual({ role: 'tool', tool_call_id: 'call_1', content: 'sunny' });
    const asst = b.messages.find((m: any) => m.role === 'assistant');
    expect(asst.tool_calls[0]).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"seoul"}' } });
  });
  it('zai backend parses streamed tool_calls', () => {
    const evs = zaiBackend.parseStreamChunk(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{}"}}]}}]}',
    );
    expect(evs).toContainEqual({ type: 'tool_call_delta', index: 0, id: 'call_1', name: 'get_weather', argsDelta: '{}' });
  });
});
