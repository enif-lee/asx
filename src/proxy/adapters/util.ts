// Shared helpers for the wire-format adapters.

// SSE line builders.
export const sseData = (obj: any): string => `data: ${JSON.stringify(obj)}\n\n`;
export const sseEvent = (event: string, data: any): string => `event: ${event}\n${sseData(data)}`;

// Headers for a streaming (SSE) response — identical for every agent.
export const sseHeaders = (): Record<string, string> => ({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
});

// Flatten message content (string | content-block array) to plain text.
export function toText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? (typeof c === 'string' ? c : '')).join('');
  return content == null ? '' : String(content);
}
