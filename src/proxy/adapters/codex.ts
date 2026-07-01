// Codex (ChatGPT subscription) backend adapter — speaks the ChatGPT Responses API.
// Verified contract (Pro account, 2026-06):
//   POST https://chatgpt.com/backend-api/codex/responses
//   headers: Authorization: Bearer <access_token>, chatgpt-account-id: <account_id>,
//            OpenAI-Beta: responses=experimental, originator: codex_cli_rs, accept: text/event-stream
//   body: { model, instructions, input:[{type:message,role,content:[{type:input_text,text}]}],
//           stream:true, store:false, tools:[], tool_choice, parallel_tool_calls, reasoning:{effort}, include:[] }
//   SSE: response.output_text.delta {delta}, response.output_text.done {text}, response.completed.
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, BackendAdapter, CommonRequest, CommonEvent, CommonResponse, StreamCtx } from '../types.js';
import { resolveChoice } from '../models.js';

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';

function extractAuth(cred: string): { token: string; account: string } {
  const d = JSON.parse(cred);
  const t = d.tokens || d;
  return { token: t.access_token || t.id_token || '', account: t.account_id || '' };
}

export const codexBackend: BackendAdapter = {
  buildRequest(req: CommonRequest, cred: string) {
    const { token, account } = extractAuth(cred);
    // Codex Responses forbids role=system in `input` — system goes only in `instructions`.
    // Fold any system-role messages (some agents leave them in the array) into instructions.
    const sys = [req.system, ...req.messages.filter((m) => m.role === 'system').map((m) => m.content)]
      .filter(Boolean).join('\n');
    const input = req.messages.filter((m) => m.role !== 'system').map((m) => ({
      type: 'message',
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
    }));
    // The agent sends the picked choice id (e.g. "gpt-5.5-high") as the model.
    const choice = resolveChoice('codex', req.model);
    const body = {
      model: choice.model,
      instructions: sys || 'You are a helpful assistant.',
      input,
      stream: true,           // codex backend only streams; server accumulates if agent wanted non-stream
      store: false,
      tools: [],              // ponytail: tool translation deferred to M2
      tool_choice: 'auto',
      parallel_tool_calls: false,
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
      } else if (j.type === 'response.completed') {
        out.push({ type: 'done', finishReason: 'stop' });
      } else if (j.type === 'response.failed' || j.type === 'error') {
        out.push({ type: 'error', message: j.response?.error?.message || j.message || 'codex error' });
      }
    }
    return out;
  },

  parseResponse(json: any): CommonResponse {
    // non-stream Responses shape (fallback; codex normally streams)
    let text = '';
    if (Array.isArray(json.output)) {
      for (const item of json.output) {
        for (const c of item.content || []) text += c.text || '';
      }
    }
    return { text };
  },
};

// Codex CLI agent adapter — the codex binary speaks the ChatGPT Responses API to the proxy.
function responsesInputToMessages(input: any): { role: string; content: string }[] {
  const items = Array.isArray(input) ? input : input ? [input] : [];
  const out: { role: string; content: string }[] = [];
  for (const it of items) {
    if (typeof it === 'string') { out.push({ role: 'user', content: it }); continue; }
    if (!it) continue;
    const role = it.role || 'user';
    let content = it.content;
    if (Array.isArray(content)) content = content.map((c: any) => c?.text ?? (typeof c === 'string' ? c : '')).join('');
    if (content || it.text) out.push({ role, content: content || it.text });
  }
  return out;
}

export const codexAgent: AgentAdapter = {
  parseRequest(_path, body): CommonRequest {
    const messages = responsesInputToMessages(body.input).filter((m) => m.role !== 'system') as any;
    const sysFromInput = responsesInputToMessages(body.input).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    return {
      model: body.model || 'codex',
      system: body.instructions || sysFromInput || undefined,
      messages,
      tools: body.tools,
      stream: body.stream !== false,
      maxTokens: body.max_output_tokens,
      temperature: body.temperature,
      reasoningEffort: body.reasoning?.effort,
    };
  },

  streamHeaders() {
    return { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
  },

  formatStreamChunk(ev: CommonEvent, ctx: StreamCtx): string {
    if (!ctx.itemId) ctx.itemId = 'msg_' + ctx.id;
    if (ev.type === 'text') {
      let out = '';
      if (ctx.first) {
        ctx.first = false;
        ctx.acc = '';
        out += resp('response.created', { type: 'response.created', response: { id: ctx.id, object: 'response', status: 'in_progress', model: ctx.model, output: [] } });
        out += resp('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: ctx.itemId, type: 'message', role: 'assistant', content: [] } });
        out += resp('response.content_part.added', { type: 'response.content_part.added', item_id: ctx.itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
      }
      ctx.acc = (ctx.acc || '') + ev.text;
      return out + resp('response.output_text.delta', { type: 'response.output_text.delta', item_id: ctx.itemId, output_index: 0, content_index: 0, delta: ev.text });
    }
    if (ev.type === 'done') {
      const text = ctx.acc || '';
      const item = { id: ctx.itemId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
      return resp('response.output_text.done', { type: 'response.output_text.done', item_id: ctx.itemId, output_index: 0, content_index: 0, text })
        + resp('response.content_part.done', { type: 'response.content_part.done', item_id: ctx.itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text } })
        + resp('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item })
        + resp('response.completed', { type: 'response.completed', response: { id: ctx.id, object: 'response', status: 'completed', model: ctx.model, output: [item] } });
    }
    return resp('response.completed', { type: 'response.completed', response: { id: ctx.id, object: 'response', status: 'completed', model: ctx.model, output: [] } });
  },

  formatResponse(resp: CommonResponse, _req: CommonRequest) {
    return {
      id: 'resp_asx', object: 'response', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: resp.text }] }],
    };
  },
};

function resp(event: string, data: any): string { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
