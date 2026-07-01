// Selectable backend models. Each choice is one entry in the agent's model picker;
// the agent sends the chosen `id` back, and the backend adapter maps it to the real
// upstream (model + reasoning effort).
//
// For a ChatGPT/codex account the base model is fixed (gpt-5.5) but reasoning effort
// is the meaningful axis, so the choices are gpt-5.5 x {low,medium,high,xhigh}.
// Override per provider with ASX_<PROV>_MODELS="id:effort,id:effort" (effort optional).

export interface BackendChoice {
  id: string;        // shown to the agent / picker
  model: string;     // real upstream model id
  effort?: string;   // reasoning effort, if the backend supports it
}

function defaults(provider: string): BackendChoice[] {
  const p = provider.toLowerCase();
  if (p === 'codex') {
    return ['high', 'medium', 'low', 'xhigh'].map((e) => ({ id: `gpt-5.5-${e}`, model: 'gpt-5.5', effort: e }));
  }
  if (p.includes('claude')) {
    return ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'].map((m) => ({ id: m, model: m }));
  }
  if (p === 'grok' || p === 'xai') {
    return ['grok-build'].map((m) => ({ id: m, model: m }));
  }
  return [{ id: 'asx-proxy', model: 'asx-proxy' }];
}

function fromEnv(provider: string): BackendChoice[] | undefined {
  const raw = process.env[`ASX_${provider.toUpperCase()}_MODELS`];
  if (!raw) return undefined;
  const choices = raw.split(',').map((s) => s.trim()).filter(Boolean).map((spec) => {
    const [model, effort] = spec.split(':');
    return { id: effort ? `${model}-${effort}` : model, model, effort: effort || undefined };
  });
  return choices.length ? choices : undefined;
}

export function backendChoices(provider: string): BackendChoice[] {
  return fromEnv(provider) || defaults(provider);
}

// Map an agent-requested id back to a concrete choice. Falls back to the default (first).
export function resolveChoice(provider: string, id?: string): BackendChoice {
  const list = backendChoices(provider);
  return list.find((c) => c.id === id) || list[0];
}
