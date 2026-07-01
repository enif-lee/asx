// Claude (Anthropic Messages) adapter — both agent and backend sides.
// Verified: claude-agent + codex-backend, and codex/grok-agent + claude-backend all return
// real answers. Backend uses Claude Code OAuth subscription inference (Bearer + claude-code beta).
import type { AgentAdapter, BackendAdapter, CommonRequest, CommonEvent, CommonResponse, StreamCtx } from '../types.js';
import { resolveChoice } from '../models.js';
import { sseEvent as anthEvent, sseHeaders, toText } from './util.js';

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
  streamHeaders: sseHeaders,
  formatStreamChunk(ev: CommonEvent, ctx: StreamCtx): string {
    // Open the message exactly once, even when the first event is done/error.
    const init = (): string => {
      if (!ctx.first) return '';
      ctx.first = false;
      return anthEvent('message_start', { type: 'message_start', message: { id: ctx.id, type: 'message', role: 'assistant', model: ctx.model, content: [], stop_reason: null } })
        + anthEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    };
    if (ev.type === 'text') {
      return init() + anthEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ev.text } });
    }
    // done or error: ensure the block was opened, then close cleanly.
    return init()
      + anthEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
      + anthEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
      + anthEvent('message_stop', { type: 'message_stop' });
  },
  formatResponse(resp: CommonResponse, _req: CommonRequest) {
    return { id: 'msg_asx', type: 'message', role: 'assistant', content: [{ type: 'text', text: resp.text }], stop_reason: 'end_turn' };
  },
};

// Claude Code OAuth requires the first system block to be exactly this identity line.
const CLAUDE_CODE_ID = "You are Claude Code, Anthropic's official CLI for Claude.";

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
    const body = {
      model: choice.model,
      system,
      messages: req.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: req.maxTokens || 8192,
    };
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
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') out.push({ type: 'text', text: j.delta.text });
      else if (j.type === 'message_stop') out.push({ type: 'done', finishReason: 'stop' });
      else if (j.type === 'error') out.push({ type: 'error', message: j.error?.message || 'anthropic error' });
    }
    return out;
  },
};
