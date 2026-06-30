// Claude (Anthropic Messages) adapter — both agent and backend sides.
// ponytail: M2, UNTESTED. Wire shapes are the documented Anthropic Messages API.
// M1 only exercises grok-agent + codex-backend; this exists so the hub is symmetric.
import type { AgentAdapter, BackendAdapter, CommonRequest, CommonEvent, CommonResponse, StreamCtx } from '../types.js';

function toText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? '').join('');
  return content == null ? '' : String(content);
}

export const claudeAgent: AgentAdapter = {
  parseRequest(_path, body): CommonRequest {
    const messages = (body.messages || []).map((m: any) => ({ role: m.role, content: toText(m.content) }));
    return {
      model: body.model || 'claude',
      system: typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? toText(body.system) : undefined,
      messages,
      tools: body.tools,
      stream: !!body.stream,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
    };
  },
  streamHeaders() {
    return { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
  },
  formatStreamChunk(ev: CommonEvent, ctx: StreamCtx): string {
    if (ev.type === 'text') {
      let out = '';
      if (ctx.first) {
        ctx.first = false;
        out += anthEvent('message_start', { type: 'message_start', message: { id: ctx.id, type: 'message', role: 'assistant', model: ctx.model, content: [], stop_reason: null } });
        out += anthEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      }
      out += anthEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ev.text } });
      return out;
    }
    if (ev.type === 'done') {
      return anthEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
        + anthEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
        + anthEvent('message_stop', { type: 'message_stop' });
    }
    return anthEvent('message_stop', { type: 'message_stop' });
  },
  formatResponse(resp: CommonResponse, _req: CommonRequest) {
    return { id: 'msg_asx', type: 'message', role: 'assistant', content: [{ type: 'text', text: resp.text }], stop_reason: 'end_turn' };
  },
};

export const claudeBackend: BackendAdapter = {
  buildRequest(req: CommonRequest, cred: string) {
    let key = cred;
    try { const d = JSON.parse(cred); key = d?.claudeAiOauth?.accessToken || d?.accessToken || d?.apiKey || cred; } catch {}
    const body = {
      model: req.model.includes('claude') ? req.model : 'claude-sonnet-4-6',
      system: req.system,
      messages: req.messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
      stream: true,
      max_tokens: req.maxTokens || 8192,
    };
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
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
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') out.push({ type: 'text', text: j.delta.text });
      else if (j.type === 'message_stop') out.push({ type: 'done', finishReason: 'stop' });
      else if (j.type === 'error') out.push({ type: 'error', message: j.error?.message || 'anthropic error' });
    }
    return out;
  },
  parseResponse(json: any): CommonResponse {
    const text = (json.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    return { text };
  },
};

function anthEvent(event: string, data: any): string { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
