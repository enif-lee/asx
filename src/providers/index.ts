import type { ProviderAdapter } from './base.js';
import { claudeCodeAdapter } from './claude-code.js';
import { createKeyAdapter } from './key-adapter.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';

// Registry
const adapters: Record<string, ProviderAdapter> = {
  'claude-code': claudeCodeAdapter,
  'claude': claudeCodeAdapter,
  'codex': codexAdapter,
  'zai': createKeyAdapter('zai'),
  'grok': createKeyAdapter('grok'),
  'xai': createKeyAdapter('grok'),
  'cursor': cursorAdapter,
};

export function getAdapter(name: string): ProviderAdapter {
  const key = name.toLowerCase();
  const a = adapters[key];
  if (!a) throw new Error(`Unknown provider: ${name}. Supported: ${Object.keys(adapters).join(', ')}`);
  return a;
}

export function listKnownProviders(): string[] {
  return Object.keys(adapters);
}
