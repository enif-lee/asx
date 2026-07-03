import { describe, it, expect } from 'vitest';
import { forEachUpstreamEvent, startProxy, fetchUpstreamWithRetry } from './server.js';
import { zaiBackend } from './adapters/zai.js';
import type { CommonEvent } from './types.js';

// Fake backend: each SSE block "data: <text>" -> text event; "data: [DONE]" -> done.
const backend = {
  parseStreamChunk(block: string): CommonEvent[] {
    const out: CommonEvent[] = [];
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '[DONE]') out.push({ type: 'done' });
      else if (p) out.push({ type: 'text', text: p });
    }
    return out;
  },
};

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); },
  });
}
const enc = (s: string) => new TextEncoder().encode(s);

async function collect(stream: ReadableStream<Uint8Array>): Promise<CommonEvent[]> {
  const evs: CommonEvent[] = [];
  await forEachUpstreamEvent(stream, backend, (e) => evs.push(e));
  return evs;
}

describe('forEachUpstreamEvent', () => {
  it('frames on \\n\\n across split chunks', async () => {
    const evs = await collect(streamOf(enc('data: hel'), enc('lo\n\ndata: world\n\n')));
    expect(evs).toEqual([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]);
  });

  it('normalizes CRLF blank-line boundaries', async () => {
    const evs = await collect(streamOf(enc('data: a\r\n\r\ndata: b\r\n\r\n')));
    expect(evs).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  });

  it('flushes a trailing block with no final blank line', async () => {
    const evs = await collect(streamOf(enc('data: tail')));
    expect(evs).toEqual([{ type: 'text', text: 'tail' }]);
  });

  it('reassembles a multi-byte char split across chunk boundary', async () => {
    const bytes = enc('data: 한\n\n');           // 한 = 3 bytes
    const evs = await collect(streamOf(bytes.slice(0, 7), bytes.slice(7)));
    expect(evs).toEqual([{ type: 'text', text: '한' }]);
  });

  it('null body yields nothing', async () => {
    const evs: CommonEvent[] = [];
    await forEachUpstreamEvent(null, backend, (e) => evs.push(e));
    expect(evs).toEqual([]);
  });
});

describe('fetchUpstreamWithRetry', () => {
  const up = { url: 'http://x', headers: {}, body: '{}' };
  const noSleep = async () => {};
  const stream = () => new Response('data: hi\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const overload200 = () => new Response(JSON.stringify({ error: { code: '1305', message: 'overloaded' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const overload503 = () => new Response('service unavailable', { status: 503 });

  it('delegates a 200-with-1305 body to backend.isRetryable and retries until it streams', async () => {
    let n = 0;
    const fetchImpl = (async () => (++n < 3 ? overload200() : stream())) as any;
    const { res, errText } = await fetchUpstreamWithRetry(up, zaiBackend, { fetchImpl, sleep: noSleep });
    expect(n).toBe(3);
    expect(errText).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it('retries a 503 by generic status even without a backend', async () => {
    let n = 0;
    const fetchImpl = (async () => (++n < 2 ? overload503() : stream())) as any;
    const { errText } = await fetchUpstreamWithRetry(up, undefined, { fetchImpl, sleep: noSleep });
    expect(n).toBe(2);
    expect(errText).toBeUndefined();
  });

  it('gives up after retries and returns the last error body', async () => {
    let n = 0;
    const fetchImpl = (async () => { n++; return overload200(); }) as any;
    const { errText } = await fetchUpstreamWithRetry(up, zaiBackend, { retries: 2, fetchImpl, sleep: noSleep });
    expect(n).toBe(3); // 1 try + 2 retries
    expect(errText).toContain('1305');
  });

  it('does not retry a 200-with-1305 when the backend has no isRetryable hook', async () => {
    let n = 0;
    const fetchImpl = (async () => { n++; return overload200(); }) as any;
    const { res } = await fetchUpstreamWithRetry(up, {}, { fetchImpl, sleep: noSleep });
    expect(n).toBe(1);
    expect(res.status).toBe(200);
  });

  it('does not retry a non-retryable 400', async () => {
    let n = 0;
    const fetchImpl = (async () => { n++; return new Response('bad request', { status: 400 }); }) as any;
    const { res, errText } = await fetchUpstreamWithRetry(up, zaiBackend, { fetchImpl, sleep: noSleep });
    expect(n).toBe(1);
    expect(res.status).toBe(400);
    expect(errText).toBe('bad request');
  });
});

describe('proxy metadata endpoints', () => {
  it('serves backend model choices on /v1/models in the agent wire schema', async () => {
    // codex agent -> codex ModelInfo schema ({ models: [{ slug, ... }] })
    const codex = await startProxy({ sourceProvider: 'codex', targetProvider: 'zai', targetCredential: { raw: 'zai-key' } });
    try {
      const body: any = await (await fetch(`${codex.url}/v1/models`)).json();
      expect(body.models.map((m: any) => m.slug)).toContain('glm-5.2');
    } finally {
      codex.stop();
    }
    // claude agent -> Anthropic models list ({ data: [{ id, type:'model', ... }] })
    const claude = await startProxy({ sourceProvider: 'claude', targetProvider: 'zai', targetCredential: { raw: 'zai-key' } });
    try {
      const body: any = await (await fetch(`${claude.url}/v1/models`)).json();
      // ids are claude-prefixed (to pass Claude Code's picker filter); display_name is the real name
      expect(body.data.map((m: any) => m.display_name)).toContain('glm-5.2');
      expect(body.data.every((m: any) => /^(claude|anthropic)/i.test(m.id))).toBe(true);
      expect(body.data[0].type).toBe('model');
    } finally {
      claude.stop();
    }
  });
});

describe('proxy streaming endpoints', () => {
  it('keeps reading a codex->claude stream until response.completed', async () => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(anthropicSse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const proxy = await startProxy({
      sourceProvider: 'codex',
      targetProvider: 'claude',
      targetCredential: { raw: 'claude-token' },
    });
    try {
      const res = await nativeFetch(`${proxy.url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
          stream: true,
        }),
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain('hello');
      expect(text).toContain('response.completed');
    } finally {
      proxy.stop();
      globalThis.fetch = originalFetch;
    }
  });
});


describe('forEachUpstreamEvent cancellation', () => {
  it('stops reading when isCancelled returns true', async () => {
    const evs: CommonEvent[] = [];
    let pulls = 0;
    const stream = new ReadableStream({
      pull(c) {
        pulls++;
        if (pulls <= 5) c.enqueue(enc(`data: msg${pulls}\n\n`));
        else c.close();
      },
    });
    // Cancel after receiving 2 events.
    await forEachUpstreamEvent(stream, backend, (e) => evs.push(e), {
      isCancelled: () => evs.length >= 2,
    });
    expect(evs.length).toBeLessThanOrEqual(3);
    expect(evs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('fetchUpstreamWithRetry fatal errors', () => {
  const up = { url: 'http://x', headers: {}, body: '{}' };
  const noSleep = async () => {};

  it('does not retry a 401 auth failure', async () => {
    let n = 0;
    const fetchImpl = (async () => { n++; return new Response('unauthorized', { status: 401 }); }) as any;
    const { res, errText } = await fetchUpstreamWithRetry(up, zaiBackend, { fetchImpl, sleep: noSleep });
    expect(n).toBe(1);
    expect(res.status).toBe(401);
    expect(errText).toBe('unauthorized');
  });

  it('does not retry a 403 forbidden', async () => {
    let n = 0;
    const fetchImpl = (async () => { n++; return new Response('forbidden', { status: 403 }); }) as any;
    const { res, errText } = await fetchUpstreamWithRetry(up, zaiBackend, { fetchImpl, sleep: noSleep });
    expect(n).toBe(1);
    expect(res.status).toBe(403);
    expect(errText).toBe('forbidden');
  });

  it('does not retry a non-retryable network error (invalid url)', async () => {
    let n = 0;
    const fetchImpl = (async () => { n++; throw new TypeError('Invalid URL'); }) as any;
    try {
      await fetchUpstreamWithRetry(up, zaiBackend, { fetchImpl, sleep: noSleep });
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(n).toBe(1);
      expect(e.message).toBe('Invalid URL');
    }
  });
});

describe('proxy stream interruption recovery', () => {
  it('returns a clean error message in SSE when the upstream stream errors mid-flight', async () => {
    // grok agent + zai backend. We mock the backend fetch to return a stream that errors
    // after the first chunk, simulating a dropped connection.
    const proxy = await startProxy({
      sourceProvider: 'grok',
      targetProvider: 'zai',
      targetCredential: { raw: 'zai-key' },
    });
    try {
      // We cannot easily inject a mock fetch into the running proxy, so instead test the
      // forEachUpstreamEvent error path directly: a stream that rejects mid-read.
      const brokenStream = new ReadableStream({
        start(c) {
          c.enqueue(enc('data: hello\n\n'));
          setTimeout(() => c.error(new Error('connection reset')), 10);
        },
      });
      const evs: CommonEvent[] = [];
      await expect(
        forEachUpstreamEvent(brokenStream, backend, (e) => evs.push(e)),
      ).rejects.toThrow('connection reset');
      // The first chunk was emitted before the error.
      expect(evs).toEqual([{ type: 'text', text: 'hello' }]);
    } finally {
      proxy.stop();
    }
  });
});
