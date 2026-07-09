// Grok CLI agent adapter — speaks OpenAI Chat Completions.
// Verified wire (grok 0.2.x, custom-model config):
//   POST /v1/chat/completions  Authorization: Bearer <dummy>
//   body { model, messages:[{role,content}], temperature, max_tokens, tools?, stream }
//   stream response: strict chat.completion.chunk (id/object/created/model/choices required),
//   terminated by `data: [DONE]`. Tool calls stream as delta.tool_calls[] and finish_reason=tool_calls.
import type { AgentAdapter, BackendAdapter, CommonRequest, CommonEvent, CommonResponse, StreamCtx } from '../types.js';
import { resolveChoice } from '../models.js';
import { sseData as sse, sseHeaders, toText, chatMessagesFromCommon, chatToolsFromCommon, chatMessagesToCommon, chatToolsToCommon, parseChatToolDeltas } from './util.js';
import { getGrokVersion } from '../../utils/platform.js';

export const grokAgent: AgentAdapter = {
  parseRequest(_path, body): CommonRequest {
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const system = msgs.filter((m: any) => m.role === 'system').map((m: any) => toText(m.content)).join('\n') || undefined;
    const messages = chatMessagesToCommon(msgs.filter((m: any) => m.role !== 'system'));
    return {
      model: body.model || 'asx-proxy',
      system,
      messages,
      tools: chatToolsToCommon(body.tools),
      toolChoice: body.tool_choice,
      parallelToolCalls: body.parallel_tool_calls,
      stream: !!body.stream,
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
      temperature: body.temperature,
    };
  },

  streamHeaders: sseHeaders,

  formatStreamChunk(ev: CommonEvent, ctx: StreamCtx): string {
    if (ctx.nextIndex == null) ctx.nextIndex = 0;
    if (!ctx.items) ctx.items = []; // records tool ids -> drives finish_reason
    const chunk = (delta: any, finish: string | null) => sse({
      id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    if (ev.type === 'text') {
      const delta: any = { content: ev.text };
      if (ctx.first) { delta.role = 'assistant'; ctx.first = false; }
      return chunk(delta, null);
    }
    if (ev.type === 'tool_call') {
      const tcIndex = ctx.nextIndex!++;
      ctx.items!.push(ev.id);
      const delta: any = { tool_calls: [{ index: tcIndex, id: ev.id, type: 'function', function: { name: ev.name, arguments: ev.arguments || '' } }] };
      if (ctx.first) { delta.role = 'assistant'; ctx.first = false; }
      return chunk(delta, null);
    }
    if (ev.type === 'done') {
      const reason = ctx.items!.length ? 'tool_calls' : (ev.finishReason || 'stop');
      return chunk({}, reason) + 'data: [DONE]\n\n';
    }
    // error -> close the stream cleanly so the agent prints what it has
    return chunk({}, 'stop') + 'data: [DONE]\n\n';
  },

  formatResponse(resp: CommonResponse, req: CommonRequest) {
    const message: any = { role: 'assistant', content: resp.text || null };
    if (resp.toolCalls?.length) {
      message.tool_calls = resp.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments || '{}' } }));
    }
    return {
      id: 'chatcmpl-asx', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: req.model,
      choices: [{ index: 0, message, finish_reason: resp.toolCalls?.length ? 'tool_calls' : (resp.finishReason || 'stop') }],
    };
  },
  // OpenAI Chat Completions GET /v1/models shape (grok's picker).
  formatModels(choices) {
    return { object: 'list', data: choices.map((c) => ({ id: c.id, object: 'model', created: 0, owned_by: 'asx-proxy' })) };
  },
};

// Grok cloud backend — cli-chat-proxy.grok.com, OpenAI Chat Completions wire, OIDC session token.
// Verified contract (grok 0.2.77): needs client-version + token-auth headers, streaming only,
// and grok-build emits `reasoning_content` deltas before the real `content` deltas.
const GROK_URL = 'https://cli-chat-proxy.grok.com/v1/chat/completions';

function grokToken(cred: string): string {
  // stored secret is either the bare JWT or a grok auth.json wrapper { "<issuer>": { key } }
  try { const d = JSON.parse(cred); const e = d[Object.keys(d)[0]]; return e?.key || d.key || cred; } catch { return cred; }
}

export const grokBackend: BackendAdapter = {
  buildRequest(req: CommonRequest, cred: string) {
    const choice = resolveChoice('grok', req.model);
    const GROK_VERSION = getGrokVersion();
    const messages = chatMessagesFromCommon(req.system, req.messages);
    const body: any = { model: choice.model, messages, stream: true };
    // Models that advertise reasoning_efforts (e.g. grok-4.5) accept reasoning_effort
    // on the chat-completions wire; effort-expanded picker ids map here.
    if (choice.effort) body.reasoning_effort = choice.effort;
    const tools = chatToolsFromCommon(req.tools);
    if (tools) {
      body.tools = tools;
      if (req.toolChoice) body.tool_choice = req.toolChoice;
      if (req.parallelToolCalls != null) body.parallel_tool_calls = req.parallelToolCalls;
    }
    return {
      url: GROK_URL,
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${grokToken(cred)}`,
        'X-XAI-Token-Auth': 'xai-grok-cli',
        'x-grok-client-version': GROK_VERSION,
        'x-grok-client-identifier': 'grok-shell',
        'User-Agent': `grok-shell/${GROK_VERSION} (macos; aarch64)`,
        'x-grok-model-override': choice.model,
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
      let j: any; try { j = JSON.parse(payload); } catch { continue; }
      const ch = j.choices?.[0];
      if (!ch) continue;
      const text = ch.delta?.content;            // ignore reasoning_content for now
      if (typeof text === 'string' && text) out.push({ type: 'text', text });
      if (Array.isArray(ch.delta?.tool_calls)) out.push(...parseChatToolDeltas(ch.delta.tool_calls));
      if (ch.finish_reason) out.push({ type: 'done', finishReason: ch.finish_reason });
    }
    return out;
  },
};
