import { describe, it, expect } from 'vitest';
import { forEachUpstreamEvent, startProxy } from './server.js';
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
