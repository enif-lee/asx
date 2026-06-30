// Adapter registry. Add a provider = add one module here. No converter changes elsewhere.
import type { AgentAdapter, BackendAdapter } from '../types.js';
import { grokAgent } from './grok.js';
import { codexBackend } from './codex.js';
import { claudeAgent, claudeBackend } from './claude.js';

const AGENTS: Record<string, AgentAdapter> = {
  grok: grokAgent,
  // codex agent (Responses-speaking binary) — M2
  claude: claudeAgent,
};

const BACKENDS: Record<string, BackendAdapter> = {
  codex: codexBackend,
  claude: claudeBackend,
  // grok backend (xAI key) — M2
};

const norm = (p: string) => (p.includes('claude') ? 'claude' : p.toLowerCase());

export function pickAgent(provider: string): AgentAdapter | undefined { return AGENTS[norm(provider)]; }
export function pickBackend(provider: string): BackendAdapter | undefined { return BACKENDS[norm(provider)]; }
