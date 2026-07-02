// Selectable backend models. Each choice is one entry in the agent's model picker;
// the agent sends the chosen `id` back, and the backend adapter maps it to the real
// upstream (model + reasoning effort).
//
// For a ChatGPT/codex account the base model is fixed (gpt-5.5) but reasoning effort
// is the meaningful axis, so the choices are gpt-5.5 x {low,medium,high,xhigh}.
// Override per provider with ASX_<PROV>_MODELS="id:effort,id:effort" (effort optional).

import fs from 'node:fs';
import path from 'node:path';
import { getAsxConfigDir } from '../utils/platform.js';

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
    return ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'].map((m) => ({ id: m, model: m }));
  }
  if (p === 'grok' || p === 'xai') {
    return ['grok-build'].map((m) => ({ id: m, model: m }));
  }
  if (p === 'zai') {
    return ['glm-5.2', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'].map((m) => ({ id: m, model: m }));
  }
  return [{ id: 'asx-proxy', model: 'asx-proxy' }];
}

// "model" or "model:effort" -> a choice. The picker id is "model-effort" (or "model").
function parseSpec(spec: string): BackendChoice {
  const [model, effort] = spec.split(':');
  return { id: effort ? `${model}-${effort}` : model, model, effort: effort || undefined };
}

// A config entry may be a "model[:effort]" string or an object { id?, model, effort? }.
function normalizeEntry(e: any): BackendChoice | null {
  if (typeof e === 'string' && e.trim()) return parseSpec(e.trim());
  if (e && typeof e === 'object' && e.model) {
    return { id: e.id || (e.effort ? `${e.model}-${e.effort}` : e.model), model: e.model, effort: e.effort || undefined };
  }
  return null;
}

// Override via env: ASX_<PROV>_MODELS="model:effort,model:effort".
function fromEnv(provider: string): BackendChoice[] | undefined {
  const raw = process.env[`ASX_${provider.toUpperCase()}_MODELS`];
  if (!raw) return undefined;
  const choices = raw.split(',').map((s) => s.trim()).filter(Boolean).map(parseSpec);
  return choices.length ? choices : undefined;
}

// Override via config file: <asx config dir>/models.json, shaped as
//   { "codex": ["gpt-5.5:high", {"id":"gpt5","model":"gpt-5.5","effort":"low"}], "zai": ["glm-5.2"] }
// Lets users rename/collapse the models shown in each agent's /model picker without env vars.
function loadConfig(): Record<string, any> | null {
  // ASX_MODELS_CONFIG overrides the path (mainly for tests); default is the asx config dir.
  const file = process.env.ASX_MODELS_CONFIG || path.join(getAsxConfigDir(), 'models.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function fromConfigFile(provider: string): BackendChoice[] | undefined {
  const cfg = loadConfig();
  const list = cfg?.[provider.toLowerCase()];
  if (!Array.isArray(list)) return undefined;
  const choices = list.map(normalizeEntry).filter((c): c is BackendChoice => c != null);
  return choices.length ? choices : undefined;
}

export function backendChoices(provider: string): BackendChoice[] {
  return fromEnv(provider) || fromConfigFile(provider) || defaults(provider);
}

// Map an agent-requested id back to a concrete choice. Falls back to the default (first).
export function resolveChoice(provider: string, id?: string): BackendChoice {
  const list = backendChoices(provider);
  return list.find((c) => c.id === id) || list[0];
}
