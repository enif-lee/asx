import { describe, it, expect } from 'vitest';
import { forEachUpstreamEvent } from './server.js';
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
