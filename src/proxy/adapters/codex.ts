// Codex (ChatGPT subscription) backend adapter — speaks the ChatGPT Responses API.
// Verified contract (Pro account, 2026-06):
//   POST https://chatgpt.com/backend-api/codex/responses
//   headers: Authorization: Bearer <access_token>, chatgpt-account-id: <account_id>,
//            OpenAI-Beta: responses=experimental, originator: codex_cli_rs, accept: text/event-stream
//   body: { model, instructions, input:[{type:message,role,content:[{type:input_text,text}]}],
//           stream:true, store:false, tools:[], tool_choice, parallel_tool_calls, reasoning:{effort}, include:[] }
//   SSE: response.output_text.delta {delta}, response.output_text.done {text}, response.completed.
import { randomUUID } from 'node:crypto';
import type { BackendAdapter, CommonRequest, CommonEvent, CommonResponse } from '../types.js';

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
// ponytail: model is account-bound; gpt-5.5 is the verified default for this ChatGPT plan.
// Override with ASX_CODEX_MODEL if the account exposes a different one.
const DEFAULT_MODEL = process.env.ASX_CODEX_MODEL || 'gpt-5.5';

function extractAuth(cred: string): { token: string; account: string } {
  const d = JSON.parse(cred);
  const t = d.tokens || d;
  return { token: t.access_token || t.id_token || '', account: t.account_id || '' };
}

export const codexBackend: BackendAdapter = {
  buildRequest(req: CommonRequest, cred: string) {
    const { token, account } = extractAuth(cred);
    const input = req.messages.map((m) => ({
      type: 'message',
      role: m.role === 'tool' ? 'user' : m.role,
      content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
    }));
    const body = {
      model: DEFAULT_MODEL,
      instructions: req.system || 'You are a helpful assistant.',
      input,
      stream: true,           // codex backend only streams; server accumulates if agent wanted non-stream
      store: false,
      tools: [],              // ponytail: tool translation deferred to M2
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: req.reasoningEffort || 'low' },
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
