import type { ProviderAdapter } from './base.js';
import { claudeCodeAdapter } from './claude-code.js';
import { createKeyAdapter } from './key-adapter.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';

// Registry
const adapters: Record<string, ProviderAdapter> = {
  'claude': claudeCodeAdapter,
  'claude-code': claudeCodeAdapter, // alias for backward compat
  'codex': codexAdapter,
  'zai': createKeyAdapter('zai'),
  'grok': createKeyAdapter('grok'),
  'cursor': cursorAdapter,
};

export function getAdapter(name: string): ProviderAdapter {
  const key = name.toLowerCase();
  const a = adapters[key];
  if (!a) throw new Error(`Unknown provider: ${name}. Supported: ${Object.keys(adapters).join(', ')}`);
  return a;
}

export function listKnownProviders(): string[] {
  return Object.keys(adapters).filter(k => k !== 'claude-code');
}

// For proxy target resolution and cross detection
export const KNOWN_TARGET_PROVIDERS = ['claude', 'codex', 'grok', 'zai', 'xai', 'openai'] as const;
export type KnownTarget = typeof KNOWN_TARGET_PROVIDERS[number];

export function normalizeProvider(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const k = p.toLowerCase();
  if (k === 'claude-code') return 'claude';
  if (k === 'xai') return 'grok'; // xai uses same wire/cred path as grok key
  if (k === 'openai') return 'openai';
  return listKnownProviders().includes(k) || KNOWN_TARGET_PROVIDERS.includes(k as any) ? k : undefined;
}

export function isKnownProvider(p?: string): boolean {
  if (!p) return false;
  const norm = normalizeProvider(p);
  return !!norm && (listKnownProviders().includes(norm) || KNOWN_TARGET_PROVIDERS.includes(norm as any));
}
