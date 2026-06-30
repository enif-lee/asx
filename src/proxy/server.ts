import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ProxyHandle, ProxyStartOptions, CommonEvent, StreamCtx } from './types.js';
import { pickAgent, pickBackend } from './adapters/index.js';
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
    dlog(`[asx-proxy] ${req.method} ${urlPath} (agent=${agentProvider}->backend=${backendProvider}, id=${reqId}${isInference ? ', inference' : ''})`);

    try {
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
      const upstreamRes = await fetch(up.url, { method: 'POST', headers: up.headers, body: up.body });
      dlog(`[asx-proxy] upstream ${up.url} -> ${upstreamRes.status}`);

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        dlog(`[asx-proxy] upstream error ${upstreamRes.status}: ${errText.slice(0, 300)}`);
      }

      const ctx: StreamCtx = { id: 'chatcmpl-asx-' + reqId, created: Math.floor(Date.now() / 1000), model: common.model, first: true };

      if (common.stream) {
        const hdrs = agent.streamHeaders();
        res.writeHead(upstreamRes.ok ? 200 : upstreamRes.status, hdrs);
        if (!upstreamRes.body) { res.end(agent.formatStreamChunk({ type: 'done' }, ctx)); return; }

        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let sawDone = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // frame upstream SSE on blank-line boundaries
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const ev of backend.parseStreamChunk(block)) {
              if (ev.type === 'done') sawDone = true;
              res.write(agent.formatStreamChunk(ev, ctx));
            }
          }
        }
        if (buf.trim()) for (const ev of backend.parseStreamChunk(buf)) { if (ev.type === 'done') sawDone = true; res.write(agent.formatStreamChunk(ev, ctx)); }
        if (!sawDone) res.write(agent.formatStreamChunk({ type: 'done' }, ctx));
        res.end();
      } else {
        // Agent wanted non-stream; backend still streams — accumulate, then format once.
        let text = '';
        let finishReason: string | undefined;
        if (upstreamRes.body) {
          const reader = upstreamRes.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          const consume = (block: string) => {
            for (const ev of backend.parseStreamChunk(block)) {
              if (ev.type === 'text') text += ev.text;
              else if (ev.type === 'done') finishReason = ev.finishReason;
            }
          };
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) { consume(buf.slice(0, idx)); buf = buf.slice(idx + 2); }
          }
          if (buf.trim()) consume(buf);
        }
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
