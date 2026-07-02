import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ProxyHandle, ProxyStartOptions, CommonEvent, StreamCtx } from './types.js';
import { pickAgent, pickBackend } from './adapters/index.js';
import { backendChoices } from './models.js';
import { dlog } from '../utils/log.js';

// Short-lived in-process proxy for one exec session.
//   agent wire ─[agent.parseRequest]─▶ COMMON ─[backend.buildRequest]─▶ upstream
//   upstream ─[backend.parseStreamChunk]─▶ COMMON ─[agent.formatStreamChunk]─▶ agent wire

export async function startProxy(options: ProxyStartOptions): Promise<ProxyHandle> {
  const port = options.port || (await getFreePort());
  const agentProvider = options.sourceProvider.toLowerCase();
  const backendProvider = options.targetProvider.toLowerCase();
  const cred = options.targetCredential?.raw || options.targetCredential?.apiKey || '';

  const agent = pickAgent(agentProvider);
  const backend = pickBackend(backendProvider);

  const server = http.createServer(async (req, res) => {
    const reqId = randomUUID().slice(0, 8);
    const urlPath = (req.url || '').split('?')[0];
    const isInference = req.method === 'POST' && /\/(v1\/)?(responses|messages|chat\/completions|completions)/.test(urlPath);
    const isModels = req.method === 'GET' && /\/(v1\/)?models\/?$/.test(urlPath);
    dlog(`[asx-proxy] ${req.method} ${urlPath} (agent=${agentProvider}->backend=${backendProvider}, id=${reqId}${isInference ? ', inference' : ''})`);

    try {
      if (isModels) {
        const choices = backendChoices(backendProvider);
        // Each agent CLI's `/model` picker wants a different models schema (codex ModelInfo,
        // Anthropic models list, OpenAI list), so the agent adapter frames it.
        const bodyOut = agent?.formatModels
          ? agent.formatModels(choices)
          : { object: 'list', data: choices.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: `asx-${backendProvider}` })) };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bodyOut));
        return;
      }

      // Non-inference startup checkpoints (auth/status/billing). Real auth is the backend cred.
      if (!isInference) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, authenticated: true, via: 'asx-proxy' }));
        return;
      }
      if (!agent) throw new Error(`no agent adapter for '${agentProvider}'`);
      if (!backend) throw new Error(`no backend adapter for '${backendProvider}'`);

      const rawBody = await readBody(req);
      let body: any; try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; }

      const common = agent.parseRequest(urlPath, body);
      dlog(`[asx-proxy] req model=${common.model} msgs=${common.messages.length} stream=${common.stream} prompt~="${(common.messages.at(-1)?.content || '').slice(0, 50)}"`);

      const up = backend.buildRequest(common, cred);
      // Retries transient overload (HTTP 429/5xx or an overload code like z.ai 1305, even on a 200).
      const { res: upstreamRes, errText } = await fetchUpstreamWithRetry(up, backend);
      dlog(`[asx-proxy] upstream ${up.url} -> ${upstreamRes.status}`);

      const ctx: StreamCtx = { id: 'chatcmpl-asx-' + reqId, created: Math.floor(Date.now() / 1000), model: common.model, first: true };

      // errText is set only when the body was already read (an error / non-stream response) —
      // surface it to the agent's output (not a 500), and return. On the happy stream path
      // errText is undefined and the SSE body below is untouched.
      if (!upstreamRes.ok || errText != null) {
        const detail = (errText ?? '').slice(0, 300);
        dlog(`[asx-proxy] upstream error ${upstreamRes.status}: ${detail}`);
        const msg = `[asx-proxy] backend ${backendProvider} error ${upstreamRes.status}: ${detail}`;
        if (common.stream) {
          res.writeHead(200, agent.streamHeaders());
          res.write(agent.formatStreamChunk({ type: 'text', text: msg }, ctx));
          res.write(agent.formatStreamChunk({ type: 'done' }, ctx));
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(agent.formatResponse({ text: msg }, common)));
        }
        return;
      }

      if (common.stream) {
        res.writeHead(200, agent.streamHeaders());
        let sawDone = false;
        const tools = toolAccumulator();
        // Tool calls arrive as fragments and complete only at stream end, so hold them
        // until 'done', then emit each as a single complete tool_call the agent can frame.
        const flush = () => { for (const t of tools.list()) res.write(agent.formatStreamChunk(t, ctx)); tools.clear(); };
        await forEachUpstreamEvent(upstreamRes.body, backend, (ev) => {
          if (ev.type === 'tool_call_delta') { tools.push(ev); return; }
          if (ev.type === 'done') { flush(); sawDone = true; }
          res.write(agent.formatStreamChunk(ev, ctx));
        });
        flush(); // stream may end without an explicit 'done'
        if (!sawDone) res.write(agent.formatStreamChunk({ type: 'done' }, ctx));
        res.end();
      } else {
        // Agent wanted non-stream; backend still streams — accumulate, then format once.
        let text = '';
        let finishReason: string | undefined;
        const tools = toolAccumulator();
        await forEachUpstreamEvent(upstreamRes.body, backend, (ev) => {
          if (ev.type === 'text') text += ev.text;
          else if (ev.type === 'tool_call_delta') tools.push(ev);
          else if (ev.type === 'done') finishReason = ev.finishReason;
        });
        const toolCalls = tools.list().map((t) => ({ id: t.id, name: t.name, arguments: t.arguments }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(agent.formatResponse({ text, toolCalls, finishReason }, common)));
      }
    } catch (err: any) {
      dlog('[asx-proxy] error:', err?.message || err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err?.message || 'proxy error' } }));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${port}`;
  dlog(`[asx-proxy] listening on ${url} (agent=${agentProvider} backend=${backendProvider})`);
  return { url, port, stop: () => { try { server.close(); } catch {} } };
}

// Read an upstream SSE body, frame it on blank-line boundaries, and emit each COMMON
// event. Normalizes CRLF, flushes the decoder at end (no truncated multi-byte UTF-8),
// and always releases the reader.
export async function forEachUpstreamEvent(
  body: ReadableStream<Uint8Array> | null,
  backend: { parseStreamChunk(block: string): CommonEvent[] },
  emit: (ev: CommonEvent) => void,
): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const drain = () => {
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const ev of backend.parseStreamChunk(block)) emit(ev);
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      drain();
    }
    buf += decoder.decode(); // flush any trailing multi-byte sequence
    drain();
    if (buf.trim()) for (const ev of backend.parseStreamChunk(buf)) emit(ev);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// Merge streamed tool_call_delta fragments (keyed by wire index) into complete tool calls,
// preserving first-seen order. id/name land on the opening fragment; args arrive in pieces.
export function toolAccumulator() {
  const byIndex = new Map<number, { id: string; name: string; args: string }>();
  const order: number[] = [];
  return {
    push(ev: { index: number; id?: string; name?: string; argsDelta?: string }) {
      let t = byIndex.get(ev.index);
      if (!t) { t = { id: '', name: '', args: '' }; byIndex.set(ev.index, t); order.push(ev.index); }
      if (ev.id) t.id = ev.id;
      if (ev.name) t.name = ev.name;
      if (ev.argsDelta) t.args += ev.argsDelta;
    },
    list(): Array<CommonEvent & { type: 'tool_call' }> {
      return order.map((i) => {
        const t = byIndex.get(i)!;
        return { type: 'tool_call' as const, id: t.id, name: t.name, arguments: t.args };
      });
    },
    clear() { byIndex.clear(); order.length = 0; },
  };
}

// Backends transiently reject with an overload/rate error. HTTP-level failures (network errors,
// 429/5xx) are universal and retried here; provider-specific body cases (e.g. z.ai's 200-with-1305)
// are delegated to backend.isRetryable. Retries use exponential backoff + jitter.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export async function fetchUpstreamWithRetry(
  up: { url: string; headers: Record<string, string>; body: string },
  backend?: { isRetryable?(status: number, body: string): boolean },
  opts: { retries?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ res: Response; errText?: string }> {
  const retries = opts.retries ?? 4;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastRes: Response | undefined;
  let lastText = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      dlog(`[asx-proxy] retry ${attempt}/${retries} after ${backoff}ms (overload)`);
      await sleep(backoff);
    }
    // Guard against an upstream that never responds/closes.
    const timeout = AbortSignal.timeout ? AbortSignal.timeout(120_000) : undefined;
    let res: Response;
    try {
      res = await doFetch(up.url, { method: 'POST', headers: up.headers, body: up.body, signal: timeout });
    } catch (e: any) {
      lastText = e?.message || 'network error'; // network failure is retryable
      continue;
    }
    lastRes = res;
    const ct = res.headers.get('content-type') || '';
    // Happy path: a streaming body — hand it back untouched so the caller can pipe it.
    if (res.ok && ct.includes('event-stream')) return { res };
    // Otherwise read the (small) body to inspect for an overload code / non-stream error.
    const text = await res.text().catch(() => '');
    lastText = text;
    const retryable = RETRYABLE_STATUS.has(res.status) || !!backend?.isRetryable?.(res.status, text);
    if (attempt < retries && retryable) continue;
    return { res, errText: text };
  }
  if (!lastRes) throw new Error(lastText || 'upstream fetch failed'); // only network errors, no Response
  return { res: lastRes, errText: lastText };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 18742;
      srv.close(() => resolve(p));
    });
    srv.on('error', () => resolve(18742));
  });
}
