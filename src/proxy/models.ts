// Single source of truth for the backend model id shown to the agent and sent upstream.
// Account-bound; override per provider via env.
export function backendModel(provider: string): string {
  const p = provider.toLowerCase();
  if (p === 'codex') return process.env.ASX_CODEX_MODEL || 'gpt-5.5';
  if (p.includes('claude')) return process.env.ASX_CLAUDE_MODEL || 'claude-sonnet-4-6';
  if (p === 'grok' || p === 'xai') return process.env.ASX_GROK_MODEL || 'grok-build';
  return process.env.ASX_MODEL || 'asx-proxy';
}
