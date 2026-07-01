// Adapter registry. Add a provider = add one module here. No converter changes elsewhere.
import type { AgentAdapter, BackendAdapter } from '../types.js';
import { grokAgent, grokBackend } from './grok.js';
import { codexBackend, codexAgent } from './codex.js';
import { claudeAgent, claudeBackend } from './claude.js';
import { zaiBackend } from './zai.js';

const AGENTS: Record<string, AgentAdapter> = {
  grok: grokAgent,
  codex: codexAgent,
  claude: claudeAgent,
};

const BACKENDS: Record<string, BackendAdapter> = {
  codex: codexBackend,
  grok: grokBackend,
  claude: claudeBackend,
  zai: zaiBackend,
};

const norm = (p: string) => (p.includes('claude') ? 'claude' : p.toLowerCase());

export function pickAgent(provider: string): AgentAdapter | undefined { return AGENTS[norm(provider)]; }
export function pickBackend(provider: string): BackendAdapter | undefined { return BACKENDS[norm(provider)]; }
