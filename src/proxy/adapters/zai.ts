import type { BackendAdapter, CommonRequest, CommonEvent } from '../types.js';
import { resolveChoice } from '../models.js';
import { chatMessagesFromCommon, chatToolsFromCommon, parseChatToolDeltas } from './util.js';

const ZAI_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

export const zaiBackend: BackendAdapter = {
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
