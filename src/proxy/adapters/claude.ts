// Claude (Anthropic Messages) adapter — both agent and backend sides.
// Verified: claude-agent + codex-backend, and codex/grok-agent + claude-backend all return
// real answers. Backend uses Claude Code OAuth subscription inference (Bearer + claude-code beta).
//
// Tool calling wire (Anthropic Messages):
//   request tools:  [{ name, description, input_schema }]
//   assistant call: content:[{type:'tool_use', id, name, input}]
//   tool result:    user content:[{type:'tool_result', tool_use_id, content}]
//   streaming:      content_block_start{tool_use} -> content_block_delta{input_json_delta} ->
//                   content_block_stop, then message_delta{stop_reason:'tool_use'}.
import type { AgentAdapter, BackendAdapter, CommonRequest, CommonEvent, CommonResponse, CommonMessage, CommonToolCall, CommonToolDef, StreamCtx } from '../types.js';
import { resolveChoice } from '../models.js';
import { sseEvent as anthEvent, sseHeaders, toText } from './util.js';

const ZERO_USAGE = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };

// Anthropic messages (blocks incl. tool_use/tool_result) -> COMMON, keeping tool sessions intact.
function anthMessagesToCommon(messages: any[]): CommonMessage[] {
  const out: CommonMessage[] = [];
  for (const m of messages || []) {
    const content = m?.content;
    if (typeof content === 'string') { if (content) out.push({ role: m.role, content }); continue; }
    if (!Array.isArray(content)) { const t = toText(content); if (t) out.push({ role: m.role, content: t }); continue; }
    let text = '';
    const toolCalls: CommonToolCall[] = [];
    const toolResults: CommonMessage[] = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text') text += b.text || '';
      else if (b.type === 'tool_use') toolCalls.push({ id: b.id || '', name: b.name || '', arguments: JSON.stringify(b.input ?? {}) });
      else if (b.type === 'tool_result') toolResults.push({ role: 'tool', content: toText(b.content), toolCallId: b.tool_use_id || '', isError: b.is_error === true || undefined });
    }
    if (m.role === 'assistant') {
      if (text || toolCalls.length) out.push({ role: 'assistant', content: text, toolCalls: toolCalls.length ? toolCalls : undefined });
    } else {
      // A user turn can carry tool_result blocks (from a prior tool_use) plus fresh text.
      for (const tr of toolResults) out.push(tr);
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

// Claude Code's gateway `/model` picker keeps ONLY models whose id matches /^(claude|anthropic)/i
// (verified in the 2.1.x binary: gatewayDiscovery filters, drops the rest, shows nothing if empty).
// So expose cross-provider backend models under a claude- prefix (display_name keeps the real
// name), and strip it back off when the agent sends the chosen id in a request.
const CLAUDE_ID_PREFIX = 'claude-asx-';
export const wrapModelId = (id: string) => (/^(claude|anthropic)/i.test(id) ? id : CLAUDE_ID_PREFIX + id);
const unwrapModelId = (id: string) => (typeof id === 'string' && id.startsWith(CLAUDE_ID_PREFIX) ? id.slice(CLAUDE_ID_PREFIX.length) : id);

export const claudeAgent: AgentAdapter = {
  parseRequest(_path, body): CommonRequest {
    const tools = Array.isArray(body.tools)
      ? body.tools.filter((t: any) => t?.name).map((t: any) => ({ name: t.name, description: t.description, parameters: t.input_schema, builtinType: t.type }))
      : undefined;
    return {
      model: unwrapModelId(body.model || 'claude'),
      system: typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? toText(body.system) : undefined,
      messages: anthMessagesToCommon(body.messages),
      tools: tools && tools.length ? tools : undefined,
      toolChoice: body.tool_choice,
      parallelToolCalls: body.tool_choice?.disable_parallel_tool_use === true ? false : undefined,
      stream: !!body.stream,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
    };
  },
  streamHeaders: sseHeaders,
  formatStreamChunk(ev: CommonEvent, ctx: StreamCtx): string {
    if (ctx.nextIndex == null) ctx.nextIndex = 0;
    if (!ctx.items) ctx.items = []; // holds emitted tool ids -> drives stop_reason
    let out = '';
    if (ctx.first) {
      ctx.first = false;
      out += anthEvent('message_start', { type: 'message_start', message: { id: ctx.id, type: 'message', role: 'assistant', model: ctx.model, content: [], stop_reason: null, usage: ZERO_USAGE } });
    }
    const openText = (): string => {
      if (ctx.textOpen) return '';
      ctx.textOpen = true;
      ctx.textIndex = ctx.nextIndex!++;
      return anthEvent('content_block_start', { type: 'content_block_start', index: ctx.textIndex, content_block: { type: 'text', text: '' } });
    };
    const closeText = (): string => {
      if (!ctx.textOpen) return '';
      ctx.textOpen = false;
      return anthEvent('content_block_stop', { type: 'content_block_stop', index: ctx.textIndex });
    };
    if (ev.type === 'text') {
      out += openText();
      return out + anthEvent('content_block_delta', { type: 'content_block_delta', index: ctx.textIndex, delta: { type: 'text_delta', text: ev.text } });
    }
    if (ev.type === 'tool_call') {
      out += closeText(); // close any open text block before the tool_use block
      const index = ctx.nextIndex!++;
      ctx.items!.push(ev.id);
      return out
        + anthEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: ev.id, name: ev.name, input: {} } })
        + anthEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: ev.arguments || '{}' } })
        + anthEvent('content_block_stop', { type: 'content_block_stop', index });
    }
    // done or error: surface error text, ensure at least one block, then close the message.
    if (ev.type === 'error') { out += openText(); out += anthEvent('content_block_delta', { type: 'content_block_delta', index: ctx.textIndex, delta: { type: 'text_delta', text: `[asx-proxy] ${ev.message}` } }); }
    if (!ctx.textOpen && !ctx.items!.length) out += openText();
    out += closeText();
    const stopReason = ctx.items!.length ? 'tool_use' : 'end_turn';
    return out
      + anthEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 0 } })
      + anthEvent('message_stop', { type: 'message_stop' });
  },
  formatResponse(resp: CommonResponse, _req: CommonRequest) {
    const content: any[] = [];
    if (resp.text) content.push({ type: 'text', text: resp.text });
    for (const tc of resp.toolCalls || []) {
      let input: any = {};
      try { input = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }
    if (!content.length) content.push({ type: 'text', text: '' });
    return { id: 'msg_asx', type: 'message', role: 'assistant', content, stop_reason: (resp.toolCalls || []).length ? 'tool_use' : 'end_turn', usage: ZERO_USAGE };
  },
  // Anthropic GET /v1/models shape. Claude Code only queries this when
  // CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 (set by the proxy injector); the returned
  // backend models then appear in `/model` as "From gateway". Claude does no validation.
  formatModels(choices) {
    // id is claude-prefixed so it survives Claude Code's /^(claude|anthropic)/ picker filter;
    // display_name keeps the real backend name the user sees. The prefix is stripped in parseRequest.
    const data = choices.map((c) => ({ id: wrapModelId(c.id), type: 'model', display_name: c.id, created_at: '2025-01-01T00:00:00Z' }));
    return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null };
  },
};

// Claude Code OAuth requires the first system block to be exactly this identity line.
const CLAUDE_CODE_ID = "You are Claude Code, Anthropic's official CLI for Claude.";

// COMMON messages -> Anthropic messages, restoring tool_use/tool_result blocks. Consecutive
// tool results merge into one user turn (Anthropic wants results grouped after the tool_use turn).
function commonToAnthMessages(messages: CommonMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block: any = { type: 'tool_result', tool_use_id: m.toolCallId || '', content: m.content ?? '' };
      if (m.isError) block.is_error = true;
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: any[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) {
        let input: any = {};
        try { input = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { input = {}; }
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    // Anthropic only allows user/assistant here — coerce anything else (e.g. a stray role) to user.
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return out;
}

function anthToolChoice(tc: any): any | undefined {
  if (!tc) return undefined;
  if (tc === 'auto') return { type: 'auto' };
  if (tc === 'required' || tc === 'any') return { type: 'any' };
  if (tc === 'none') return undefined; // Anthropic has no 'none'; omit -> defaults to auto
  if (typeof tc === 'object' && tc.name) return { type: 'tool', name: tc.name };
  if (typeof tc === 'object' && tc.type) return tc; // already Anthropic-shaped
  return undefined;
}

export const claudeBackend: BackendAdapter = {
  buildRequest(req: CommonRequest, cred: string) {
    let token = cred;
    try {
      const d = JSON.parse(cred);
      token = d?.type === 'claude-code-oauth-token'
        ? d.token
        : d?.claudeAiOauth?.accessToken || d?.accessToken || d?.apiKey || cred;
    } catch {}
    const choice = resolveChoice('claude', req.model);
    // First system block must be the Claude Code identity; real instructions follow.
    const system = [{ type: 'text', text: CLAUDE_CODE_ID }];
    if (req.system && req.system !== CLAUDE_CODE_ID) system.push({ type: 'text', text: req.system });
    const body: any = {
      model: choice.model,
      system,
      messages: commonToAnthMessages(req.messages),
      stream: true,
      max_tokens: req.maxTokens || 8192,
    };
    // Disable extended thinking: a cross-provider agent (codex/grok) cannot store Anthropic
    // thinking blocks + signatures, and replaying a tool-use turn without them is a hard 400
    // ("thinking blocks ... cannot be modified"). Disabling returns only text/tool_use, so the
    // plain tool_use/tool_result loop works. Fable 5 cannot disable thinking, so we omit it there.
    // We also never send temperature/top_p/top_k — Opus 4.7/4.8 and Fable 5 reject them (400).
    if (!/fable/i.test(choice.model)) body.thinking = { type: 'disabled' };
    const tools = (req.tools || []).map((t: CommonToolDef) => (
      t.builtinType
        ? { type: t.builtinType, name: t.name } // built-in tool (bash/text_editor/...) — no input_schema
        : { name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } }
    ));
    if (tools.length) {
      body.tools = tools;
      const tc = anthToolChoice(req.toolChoice) || (req.parallelToolCalls === false ? { type: 'auto' } : undefined);
      if (tc) body.tool_choice = req.parallelToolCalls === false ? { ...tc, disable_parallel_tool_use: true } : tc;
    }
    return {
      // OAuth subscription inference (verified): Bearer token + claude-code beta, ?beta=true.
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    };
  },
  parseStreamChunk(block: string): CommonEvent[] {
    const out: CommonEvent[] = [];
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let j: any; try { j = JSON.parse(payload); } catch { continue; }
      if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
        out.push({ type: 'tool_call_delta', index: j.index ?? 0, id: j.content_block.id, name: j.content_block.name });
      } else if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
        out.push({ type: 'text', text: j.delta.text });
      } else if (j.type === 'content_block_delta' && j.delta?.type === 'input_json_delta' && typeof j.delta.partial_json === 'string') {
        out.push({ type: 'tool_call_delta', index: j.index ?? 0, argsDelta: j.delta.partial_json });
      } else if (j.type === 'message_stop') {
        out.push({ type: 'done', finishReason: 'stop' });
      } else if (j.type === 'error') {
        out.push({ type: 'error', message: j.error?.message || 'anthropic error' });
      }
    }
    return out;
  },
};
