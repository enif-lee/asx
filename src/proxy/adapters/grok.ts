// Grok CLI agent adapter — speaks OpenAI Chat Completions.
// Verified wire (grok 0.2.x, custom-model config):
//   POST /v1/chat/completions  Authorization: Bearer <dummy>
//   body { model, messages:[{role,content}], temperature, max_tokens, tools?, stream }
//   stream response: strict chat.completion.chunk (id/object/created/model/choices required),
//   terminated by `data: [DONE]`.
import type { AgentAdapter, BackendAdapter, CommonRequest, CommonEvent, CommonResponse, StreamCtx } from '../types.js';
import { resolveChoice } from '../models.js';
import { sseData as sse, sseHeaders, toText } from './util.js';

export const grokAgent: AgentAdapter = {
  parseRequest(_path, body): CommonRequest {
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const system = msgs.filter((m: any) => m.role === 'system').map((m: any) => toText(m.content)).join('\n') || undefined;
    const messages = msgs
      .filter((m: any) => m.role !== 'system')
      .map((m: any) => ({ role: m.role, content: toText(m.content) }));
    return {
      model: body.model || 'asx-proxy',
      system,
      messages,
      tools: body.tools,
      stream: !!body.stream,
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
      temperature: body.temperature,
    };
  },

  streamHeaders: sseHeaders,

  formatStreamChunk(ev: CommonEvent, ctx: StreamCtx): string {
    if (ev.type === 'text') {
      const delta: any = { content: ev.text };
      if (ctx.first) { delta.role = 'assistant'; ctx.first = false; }
      return sse({ id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.model,
        choices: [{ index: 0, delta, finish_reason: null }] });
    }
    if (ev.type === 'done') {
      return sse({ id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.model,
        choices: [{ index: 0, delta: {}, finish_reason: ev.finishReason || 'stop' }] }) + 'data: [DONE]\n\n';
    }
    // error -> close the stream cleanly so the agent prints what it has
    return sse({ id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
  },

  formatResponse(resp: CommonResponse, req: CommonRequest) {
    return {
      id: 'chatcmpl-asx', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: resp.text }, finish_reason: resp.finishReason || 'stop' }],
    };
  },
};

// Grok cloud backend — cli-chat-proxy.grok.com, OpenAI Chat Completions wire, OIDC session token.
// Verified contract (grok 0.2.77): needs client-version + token-auth headers, streaming only,
// and grok-build emits `reasoning_content` deltas before the real `content` deltas.
const GROK_URL = 'https://cli-chat-proxy.grok.com/v1/chat/completions';
// ponytail: pinned to the installed grok version; bump if the proxy rejects it. Upgrade path =
// read ~/.grok/version.json, but a stale-but-recent version is accepted so a constant is fine.
const GROK_VERSION = '0.2.77';

function grokToken(cred: string): string {
  // stored secret is either the bare JWT or a grok auth.json wrapper { "<issuer>": { key } }
  try { const d = JSON.parse(cred); const e = d[Object.keys(d)[0]]; return e?.key || d.key || cred; } catch { return cred; }
}

export const grokBackend: BackendAdapter = {
  buildRequest(req: CommonRequest, cred: string) {
    const choice = resolveChoice('grok', req.model);
    const messages = [] as any[];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) messages.push({ role: m.role === 'tool' ? 'user' : m.role, content: m.content });
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
      body: JSON.stringify({ model: choice.model, messages, stream: true }),
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
      if (ch.finish_reason) out.push({ type: 'done', finishReason: ch.finish_reason });
    }
    return out;
  },
};
