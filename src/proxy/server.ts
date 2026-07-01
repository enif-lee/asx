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
        const data = backendChoices(backendProvider).map((m) => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: `asx-${backendProvider}`,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data }));
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
      // Guard against an upstream that never responds/closes.
      const timeout = AbortSignal.timeout ? AbortSignal.timeout(120_000) : undefined;
      const upstreamRes = await fetch(up.url, { method: 'POST', headers: up.headers, body: up.body, signal: timeout });
      dlog(`[asx-proxy] upstream ${up.url} -> ${upstreamRes.status}`);

      const ctx: StreamCtx = { id: 'chatcmpl-asx-' + reqId, created: Math.floor(Date.now() / 1000), model: common.model, first: true };

      // Upstream error: consume the body once for the message, surface it to the agent's
      // output (not a 500), and return — never fall through to re-read the locked stream.
      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        dlog(`[asx-proxy] upstream error ${upstreamRes.status}: ${errText.slice(0, 300)}`);
        const msg = `[asx-proxy] backend ${backendProvider} error ${upstreamRes.status}: ${errText.slice(0, 300)}`;
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
        await forEachUpstreamEvent(upstreamRes.body, backend, (ev) => {
          if (ev.type === 'done') sawDone = true;
          res.write(agent.formatStreamChunk(ev, ctx));
        });
        if (!sawDone) res.write(agent.formatStreamChunk({ type: 'done' }, ctx));
        res.end();
      } else {
        // Agent wanted non-stream; backend still streams — accumulate, then format once.
        let text = '';
        let finishReason: string | undefined;
        await forEachUpstreamEvent(upstreamRes.body, backend, (ev) => {
          if (ev.type === 'text') text += ev.text;
          else if (ev.type === 'done') finishReason = ev.finishReason;
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(agent.formatResponse({ text, finishReason }, common)));
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
