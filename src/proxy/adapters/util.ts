// Shared helpers for the wire-format adapters.
import type { CommonMessage, CommonToolDef, CommonEvent } from '../types.js';

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

// --- OpenAI Chat Completions helpers (shared by grok + zai backends and the grok agent) ---

// COMMON messages -> Chat Completions messages, restoring assistant tool_calls and role=tool
// results so a multi-turn tool session survives the round trip.
export function chatMessagesFromCommon(system: string | undefined, messages: CommonMessage[]): any[] {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') { out.push({ role: 'tool', tool_call_id: m.toolCallId || '', content: m.content ?? '' }); continue; }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments || '{}' } })),
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

// COMMON tool defs -> Chat Completions `tools`.
export function chatToolsFromCommon(tools?: CommonToolDef[]): any[] | undefined {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => {
    const fn: any = { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } };
    if (t.strict != null) fn.strict = t.strict;
    return { type: 'function', function: fn };
  });
}

// Chat Completions request messages -> COMMON (assistant tool_calls, role=tool results).
export function chatMessagesToCommon(messages: any[]): CommonMessage[] {
  const out: CommonMessage[] = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'tool') { out.push({ role: 'tool', content: toText(m.content), toolCallId: m.tool_call_id || '', toolName: m.name }); continue; }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.push({
        role: 'assistant',
        content: toText(m.content),
        toolCalls: m.tool_calls.map((tc: any) => ({
          id: tc.id || '',
          name: tc.function?.name || '',
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
        })),
      });
      continue;
    }
    out.push({ role: m.role, content: toText(m.content) });
  }
  return out;
}

// Chat Completions request tools -> COMMON tool defs.
export function chatToolsToCommon(tools: any): CommonToolDef[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out: CommonToolDef[] = [];
  for (const t of tools) {
    const fn = t?.function || t;
    if (!fn?.name) continue;
    out.push({ name: fn.name, description: fn.description, parameters: fn.parameters, strict: fn.strict });
  }
  return out.length ? out : undefined;
}

// Chat Completions streaming `delta.tool_calls[]` fragments -> COMMON tool_call_delta events.
export function parseChatToolDeltas(toolCalls: any[]): CommonEvent[] {
  const out: CommonEvent[] = [];
  for (const tc of toolCalls || []) {
    if (!tc) continue;
    out.push({
      type: 'tool_call_delta',
      index: tc.index ?? 0,
      id: tc.id,
      name: tc.function?.name,
      argsDelta: typeof tc.function?.arguments === 'string' ? tc.function.arguments : undefined,
    });
  }
  return out;
}
