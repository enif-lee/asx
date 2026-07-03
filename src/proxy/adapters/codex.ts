// Codex (ChatGPT subscription) backend adapter — speaks the ChatGPT Responses API.
// Verified contract (Pro account, 2026-06):
//   POST https://chatgpt.com/backend-api/codex/responses
//   headers: Authorization: Bearer <access_token>, chatgpt-account-id: <account_id>,
//            OpenAI-Beta: responses=experimental, originator: codex_cli_rs, accept: text/event-stream
//   body: { model, instructions, input:[{type:message,role,content:[{type:input_text,text}]}],
//           stream:true, store:false, tools:[...], tool_choice, parallel_tool_calls, reasoning:{effort}, include:[] }
//   SSE: response.output_text.delta {delta}, response.output_text.done {text},
//        response.output_item.added/done {item:{type:function_call,...}},
//        response.function_call_arguments.delta {delta}, response.completed.
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, BackendAdapter, CommonRequest, CommonEvent, CommonResponse, CommonMessage, CommonToolDef, StreamCtx } from '../types.js';
import { resolveChoice } from '../models.js';
import { sseEvent as resp, sseHeaders, toText } from './util.js';

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';

function extractAuth(cred: string): { token: string; account: string } {
  try {
    const d = JSON.parse(cred);
    const t = d.tokens || d;
    return { token: t.access_token || t.id_token || '', account: t.account_id || '' };
  } catch {
    return { token: cred, account: '' }; // cred was a bare token, not an auth.json
  }
}

// COMMON tool defs -> Responses flat function tools.
function toResponsesTools(tools?: CommonToolDef[]): any[] {
  return (tools || []).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description || '',
    parameters: t.parameters || { type: 'object', properties: {} },
    strict: t.strict ?? false,
  }));
}

// COMMON messages -> Responses `input` items, preserving tool calls/results so a
// multi-turn tool session survives the round trip (the "session" the agent replays).
function messagesToInput(messages: CommonMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // folded into instructions
    if (m.role === 'tool') {
      out.push({ type: 'function_call_output', call_id: m.toolCallId || '', output: m.content ?? '' });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      if (m.content) out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      for (const tc of m.toolCalls) {
        out.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments || '{}' });
      }
      continue;
    }
    out.push({
      type: 'message',
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
    });
  }
  return out;
}

export const codexBackend: BackendAdapter = {
  buildRequest(req: CommonRequest, cred: string) {
    const { token, account } = extractAuth(cred);
    // Codex Responses forbids role=system in `input` — system goes only in `instructions`.
    // Fold any system-role messages (some agents leave them in the array) into instructions.
    const sys = [req.system, ...req.messages.filter((m) => m.role === 'system').map((m) => m.content)]
      .filter(Boolean).join('\n');
    const input = messagesToInput(req.messages);
    // The agent sends the picked choice id (e.g. "gpt-5.5-high") as the model.
    const choice = resolveChoice('codex', req.model);
    const tools = toResponsesTools(req.tools);
    const body = {
      model: choice.model,
      instructions: sys || 'You are a helpful assistant.',
      input,
      stream: true,           // codex backend only streams; server accumulates if agent wanted non-stream
      store: false,
      tools,
      tool_choice: req.toolChoice || 'auto',
      parallel_tool_calls: req.parallelToolCalls ?? false,
      reasoning: { effort: choice.effort || req.reasoningEffort || 'low' },
      include: [],
    };
    return {
      url: CODEX_URL,
      headers: {
        Authorization: `Bearer ${token}`,
        'chatgpt-account-id': account,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        'content-type': 'application/json',
        accept: 'text/event-stream',
        session_id: randomUUID(),
      },
      body: JSON.stringify(body),
    };
  },

  parseStreamChunk(block: string): CommonEvent[] {
    const out: CommonEvent[] = [];
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j: any;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.type === 'response.output_text.delta' && typeof j.delta === 'string') {
        out.push({ type: 'text', text: j.delta });
      } else if (j.type === 'response.output_item.added' && j.item?.type === 'function_call') {
        // Opening fragment carries id + name (and sometimes complete args inline).
        out.push({
          type: 'tool_call_delta',
          index: j.output_index ?? 0,
          id: j.item.call_id || j.item.id,
          name: j.item.name,
          argsDelta: typeof j.item.arguments === 'string' && j.item.arguments ? j.item.arguments : undefined,
        });
      } else if (j.type === 'response.function_call_arguments.delta' && typeof j.delta === 'string') {
        out.push({ type: 'tool_call_delta', index: j.output_index ?? 0, argsDelta: j.delta });
      } else if (j.type === 'response.completed') {
        out.push({ type: 'done', finishReason: 'stop' });
      } else if (j.type === 'response.failed' || j.type === 'error') {
        out.push({ type: 'error', message: j.response?.error?.message || j.message || 'codex error' });
      }
    }
    return out;
  },
};

// Codex CLI agent adapter — the codex binary speaks the ChatGPT Responses API to the proxy.
// Turn a Responses `input` array into COMMON messages, preserving function_call /
// function_call_output items so tool sessions replayed by the agent are not dropped.
function responsesInputToMessages(input: any): CommonMessage[] {
  const items = Array.isArray(input) ? input : input ? [input] : [];
  const out: CommonMessage[] = [];
  for (const it of items) {
    if (typeof it === 'string') { out.push({ role: 'user', content: it }); continue; }
    if (!it) continue;
    if (it.type === 'function_call') {
      out.push({
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: it.call_id || it.id || '',
          // Replayed namespaced calls carry {name, namespace} — re-flatten so history
          // matches the flattened tool defs the backend saw.
          name: (it.namespace ? `${it.namespace}__` : '') + (it.name || ''),
          arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {}),
        }],
      });
      continue;
    }
    if (it.type === 'function_call_output') {
      out.push({
        role: 'tool',
        content: typeof it.output === 'string' ? it.output : JSON.stringify(it.output ?? ''),
        toolCallId: it.call_id || it.id || '',
      });
      continue;
    }
    // Codex uses the `developer` role for instructions; COMMON has no such role, so fold
    // it into `system` (real Anthropic/chat backends reject an unknown "developer" role).
    const role = it.role === 'developer' ? 'system' : (it.role || 'user');
    const content = Array.isArray(it.content) ? toText(it.content) : (it.content ?? it.text ?? '');
    if (content) out.push({ role, content });
  }
  return out;
}

// Responses tool defs (flat `{type:'function', name, ...}`, nested `{function:{...}}`, or codex
// namespace groups `{type:'namespace', name, tools:[{type:'function',...}]}`) -> COMMON.
// Codex ships multi-agent tools as a namespace group (e.g. multi_agent_v1 containing spawn_agent)
// and expects calls back as {name:'spawn_agent', namespace:'multi_agent_v1'} — so we flatten
// members to `${ns}__${name}` for backends (Anthropic tool names forbid '.') and record the
// namespaces so the response side can split the flat name back apart.
function parseTools(tools: any): { defs?: CommonToolDef[]; namespaces?: string[] } {
  if (!Array.isArray(tools) || !tools.length) return {};
  const defs: CommonToolDef[] = [];
  const namespaces: string[] = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type === 'namespace' && t.name && Array.isArray(t.tools)) {
      namespaces.push(t.name);
      for (const nt of t.tools) {
        if (!nt?.name) continue;
        defs.push({ name: `${t.name}__${nt.name}`, description: nt.description, parameters: nt.parameters, strict: nt.strict });
      }
      continue;
    }
    const fn = t.function || t;
    if (!fn.name) continue; // skip built-in tools (web_search, etc.) with no function shape
    defs.push({ name: fn.name, description: fn.description, parameters: fn.parameters, strict: t.strict ?? fn.strict });
  }
  return { defs: defs.length ? defs : undefined, namespaces: namespaces.length ? namespaces : undefined };
}

// Reverse of the parseTools flattening: `multi_agent_v1__spawn_agent` -> {namespace, name}.
// Only splits under a namespace the request actually declared — MCP tool names legitimately
// contain '__' and must pass through untouched.
function splitNamespaced(flat: string, namespaces?: string[]): { name: string; namespace?: string } {
  for (const ns of namespaces || []) {
    if (flat.startsWith(ns + '__')) return { namespace: ns, name: flat.slice(ns.length + 2) };
  }
  return { name: flat };
}

export const codexAgent: AgentAdapter = {
  parseRequest(_path, body): CommonRequest {
    const all = responsesInputToMessages(body.input);
    const messages = all.filter((m) => m.role !== 'system');
    const sysFromInput = all.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const { defs: tools, namespaces } = parseTools(body.tools);
    // Combine top-level instructions with any developer/system input (don't drop either).
    return {
      model: body.model || 'codex',
      system: [body.instructions, sysFromInput].filter(Boolean).join('\n') || undefined,
      messages,
      tools,
      toolNamespaces: namespaces,
      toolChoice: body.tool_choice,
      parallelToolCalls: body.parallel_tool_calls,
      stream: body.stream !== false,
      maxTokens: body.max_output_tokens,
      temperature: body.temperature,
      reasoningEffort: body.reasoning?.effort,
    };
  },

  streamHeaders: sseHeaders,

  formatStreamChunk(ev: CommonEvent, ctx: StreamCtx): string {
    if (ctx.nextIndex == null) ctx.nextIndex = 0;
    if (!ctx.items) ctx.items = [];
    let out = '';
    // response.created exactly once, even when the first event is done/error.
    if (ctx.first) {
      ctx.first = false;
      out += resp('response.created', { type: 'response.created', response: { id: ctx.id, object: 'response', status: 'in_progress', model: ctx.model, output: [] } });
    }
    const openText = (): string => {
      if (ctx.textOpen) return '';
      ctx.textOpen = true;
      ctx.textIndex = ctx.nextIndex!++;
      ctx.itemId = 'msg_' + ctx.id;
      ctx.acc = '';
      return resp('response.output_item.added', { type: 'response.output_item.added', output_index: ctx.textIndex, item: { id: ctx.itemId, type: 'message', role: 'assistant', content: [] } })
        + resp('response.content_part.added', { type: 'response.content_part.added', item_id: ctx.itemId, output_index: ctx.textIndex, content_index: 0, part: { type: 'output_text', text: '' } });
    };
    const closeText = (): string => {
      if (!ctx.textOpen) return '';
      ctx.textOpen = false;
      const text = ctx.acc || '';
      const item = { id: ctx.itemId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
      ctx.items!.push(item);
      return resp('response.output_text.done', { type: 'response.output_text.done', item_id: ctx.itemId, output_index: ctx.textIndex, content_index: 0, text })
        + resp('response.content_part.done', { type: 'response.content_part.done', item_id: ctx.itemId, output_index: ctx.textIndex, content_index: 0, part: { type: 'output_text', text } })
        + resp('response.output_item.done', { type: 'response.output_item.done', output_index: ctx.textIndex, item });
    };

    if (ev.type === 'text') {
      out += openText();
      ctx.acc = (ctx.acc || '') + ev.text;
      return out + resp('response.output_text.delta', { type: 'response.output_text.delta', item_id: ctx.itemId, output_index: ctx.textIndex, content_index: 0, delta: ev.text });
    }

    if (ev.type === 'tool_call') {
      out += closeText(); // finish any open text item before starting a function call
      const idx = ctx.nextIndex!++;
      const itemId = 'fc_' + (ev.id || idx);
      const callId = ev.id || itemId;
      const args = ev.arguments || '{}';
      // Namespace-flattened names go back as {name, namespace} — codex routes on the pair.
      const { name, namespace } = splitNamespaced(ev.name, ctx.toolNamespaces);
      const nsField = namespace ? { namespace } : {};
      const item = { id: itemId, type: 'function_call', call_id: callId, name, ...nsField, arguments: args };
      ctx.items!.push(item);
      return out
        + resp('response.output_item.added', { type: 'response.output_item.added', output_index: idx, item: { id: itemId, type: 'function_call', call_id: callId, name, ...nsField, arguments: '' } })
        + resp('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: itemId, output_index: idx, delta: args })
        + resp('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: itemId, output_index: idx, arguments: args })
        + resp('response.output_item.done', { type: 'response.output_item.done', output_index: idx, item });
    }

    // done or error: surface any error text, ensure at least one well-formed item, then complete.
    if (ev.type === 'error') { out += openText(); ctx.acc = (ctx.acc || '') + `[asx-proxy] ${ev.message}`; }
    if (!ctx.textOpen && !ctx.items!.length) out += openText();
    out += closeText();
    return out + resp('response.completed', { type: 'response.completed', response: { id: ctx.id, object: 'response', status: 'completed', model: ctx.model, output: ctx.items } });
  },

  formatResponse(resp: CommonResponse, req: CommonRequest) {
    const output: any[] = [];
    if (resp.text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: resp.text }] });
    for (const tc of resp.toolCalls || []) {
      const { name, namespace } = splitNamespaced(tc.name, req.toolNamespaces);
      output.push({ id: 'fc_' + tc.id, type: 'function_call', call_id: tc.id, name, ...(namespace ? { namespace } : {}), arguments: tc.arguments || '{}' });
    }
    if (!output.length) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] });
    return { id: 'resp_asx', object: 'response', status: 'completed', output };
  },

  // Codex 0.142.x deserializes GET /models into { models: ModelInfo[] } where ModelInfo has many
  // required fields (slug/display_name/truncation_policy/...). Anything less makes codex fall back
  // to degraded metadata and leaves the `/model` picker empty.
  formatModels(choices) {
    return { models: choices.map((c, i) => codexModelInfo(c.id, i, { effort: c.effort })) };
  },
};

const REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
];

export function codexModelInfo(slug: string, priority = 0, opts: { effort?: string; provider?: string; hidden?: boolean } = {}) {
  return {
    slug,
    display_name: slug,
    description: null,
    default_reasoning_level: opts.effort || 'medium',
    supported_reasoning_levels: REASONING_LEVELS,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    base_instructions: '',
    supports_reasoning_summaries: true,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 200000,
    max_context_window: 200000,
    auto_compact_token_limit: null,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    supports_search_tool: false,
    service_tiers: [],
    additional_speed_tiers: [],
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.hidden !== undefined ? { hidden: opts.hidden } : {}),
  };
}
