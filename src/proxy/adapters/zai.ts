import type { BackendAdapter, CommonRequest, CommonEvent } from '../types.js';
import { resolveChoice } from '../models.js';
import { chatMessagesFromCommon, chatToolsFromCommon, parseChatToolDeltas } from './util.js';

const ZAI_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

// z.ai signals transient overload/rate limits with these codes — sometimes on a 200 body
// ({"error":{"code":"1305","message":"...temporarily overloaded..."}}), which generic 5xx/429
// retry would miss. Kept here (not the server) so overload semantics live with the provider.
const ZAI_RETRY_CODES = ['1305', '1304', '1302', '1301'];

export function isZaiOverload(body: string): boolean {
  if (!body) return false;
  if (ZAI_RETRY_CODES.some((c) => body.includes(`"${c}"`))) return true;
  return /overload|try again later|rate limit|too many requests/i.test(body);
}

export const zaiBackend: BackendAdapter = {
  isRetryable(_status: number, body: string) { return isZaiOverload(body); },

  buildRequest(req: CommonRequest, cred: string) {
    const choice = resolveChoice('zai', req.model);
    const messages = chatMessagesFromCommon(req.system, req.messages);
    const body: any = {
      model: choice.model,
      messages,
      stream: true,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    };
    // GLM reasoning control. z.ai's coding endpoint takes `thinking: {type}` (not OpenAI's
    // reasoning_effort). ponytail: high/max collapse to "enabled" — swap to reasoning_effort
    // if z.ai confirms it accepts graded effort. No effort (e.g. glm-4.5-air) -> model default.
    const effort = choice.effort || req.reasoningEffort;
    if (effort) body.thinking = { type: effort === 'none' || effort === 'off' ? 'disabled' : 'enabled' };
    const tools = chatToolsFromCommon(req.tools);
    if (tools) { body.tools = tools; if (req.toolChoice) body.tool_choice = req.toolChoice; }
    return {
      url: ZAI_URL,
      headers: {
        Authorization: `Bearer ${cred}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
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
      const text = ch?.delta?.content ?? ch?.message?.content;
      if (typeof text === 'string' && text) out.push({ type: 'text', text });
      const toolCalls = ch?.delta?.tool_calls ?? ch?.message?.tool_calls;
      if (Array.isArray(toolCalls)) out.push(...parseChatToolDeltas(toolCalls));
      if (ch?.finish_reason) out.push({ type: 'done', finishReason: ch.finish_reason });
    }
    return out;
  },
};
