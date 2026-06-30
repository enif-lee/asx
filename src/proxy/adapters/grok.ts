// Grok CLI agent adapter — speaks OpenAI Chat Completions.
// Verified wire (grok 0.2.x, custom-model config):
//   POST /v1/chat/completions  Authorization: Bearer <dummy>
//   body { model, messages:[{role,content}], temperature, max_tokens, tools?, stream }
//   stream response: strict chat.completion.chunk (id/object/created/model/choices required),
//   terminated by `data: [DONE]`.
import type { AgentAdapter, CommonRequest, CommonEvent, CommonResponse, StreamCtx } from '../types.js';

function toText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? (typeof c === 'string' ? c : '')).join('');
  return content == null ? '' : String(content);
}

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

  streamHeaders() {
    return { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
  },

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

function sse(obj: any): string { return `data: ${JSON.stringify(obj)}\n\n`; }
