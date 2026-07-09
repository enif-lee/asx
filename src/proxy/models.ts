// Selectable backend models. Each choice is one entry in the agent's model picker;
// the agent sends the chosen `id` back, and the backend adapter maps it to the real
// upstream (model + reasoning effort).
//
// Resolution order (first hit wins):
//   1. env  ASX_<PROV>_MODELS="id:effort,id:effort"
//   2. file <asx config dir>/models.json
//   3. remote API (Grok CLI / Z.AI), cached after refreshBackendChoices()
//   4. built-in defaults
//
// Call refreshBackendChoices(provider, { credential }) once per proxy/exec session so
// GET /v1/models and resolveChoice see the live list. Without a refresh, remote is empty
// and defaults apply.

import fs from 'node:fs';
import path from 'node:path';
import { getAsxConfigDir, getGrokVersion } from '../utils/platform.js';
import { dlog } from '../utils/log.js';

export interface BackendChoice {
  id: string;        // shown to the agent / picker
  model: string;     // real upstream model id
  effort?: string;   // reasoning effort, if the backend supports it
}

// In-process remote cache. Keyed by provider. TTL is soft — refreshBackendChoices always
// re-fetches when credential is provided; resolve/backendChoices only read the cache.
const remoteCache = new Map<string, BackendChoice[]>();

function defaults(provider: string): BackendChoice[] {
  const p = provider.toLowerCase();
  if (p === 'codex') {
    // GPT-5.6 family (Sol/Terra/Luna) as exposed by Codex model catalog 2026-07.
    // First four entries map to Claude's Opus/Sonnet/Haiku/Fable slots AND to agent
    // tier aliases (model: "haiku" → slot 2). Haiku uses Sol-low (same family as the
    // default, lower effort) rather than Luna: Luna is often preview-gated and 404s
    // for accounts that already have Sol, which breaks Claude Task subagents that
    // request model:"haiku".
    const out: BackendChoice[] = [
      { id: 'gpt-5.6-sol-high', model: 'gpt-5.6-sol', effort: 'high' },     // opus
      { id: 'gpt-5.6-sol-medium', model: 'gpt-5.6-sol', effort: 'medium' }, // sonnet
      { id: 'gpt-5.6-sol-low', model: 'gpt-5.6-sol', effort: 'low' },       // haiku
      { id: 'gpt-5.6-sol-xhigh', model: 'gpt-5.6-sol', effort: 'xhigh' },   // fable
    ];
    for (const e of ['max', 'ultra'] as const) {
      out.push({ id: `gpt-5.6-sol-${e}`, model: 'gpt-5.6-sol', effort: e });
    }
    for (const e of ['high', 'medium', 'low', 'xhigh', 'max', 'ultra'] as const) {
      out.push({ id: `gpt-5.6-terra-${e}`, model: 'gpt-5.6-terra', effort: e });
    }
    for (const e of ['high', 'medium', 'low', 'xhigh', 'max'] as const) {
      out.push({ id: `gpt-5.6-luna-${e}`, model: 'gpt-5.6-luna', effort: e });
    }
    // Keep GPT-5.5 for accounts/workflows still pinned to 5.5
    for (const e of ['high', 'medium', 'low', 'xhigh'] as const) {
      out.push({ id: `gpt-5.5-${e}`, model: 'gpt-5.5', effort: e });
    }
    return out;
  }
  if (p.includes('claude')) {
    return ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'].map((m) => ({ id: m, model: m }));
  }
  if (p === 'grok' || p === 'xai') {
    // Fallback when the CLI models API is unreachable. Live accounts typically get a
    // richer list from https://cli-chat-proxy.grok.com/v1/models (see fetchGrokModels).
    return ['grok-build'].map((m) => ({ id: m, model: m }));
  }
  if (p === 'zai') {
    // Per z.ai docs: glm-5.2 (coding default), glm-5.2[1m] (1M context), glm-4.5-air (fast).
    // effort maps to GLM thinking: any effort -> thinking enabled (see zai backend). glm-4.5-air
    // stays non-thinking. Override with ASX_ZAI_MODELS / models.json.
    return [
      { id: 'glm-5.2', model: 'glm-5.2', effort: 'high' },
      { id: 'glm-5.2-max', model: 'glm-5.2', effort: 'max' },
      { id: 'glm-5.2[1m]', model: 'glm-5.2[1m]', effort: 'high' },
      { id: 'glm-4.5-air', model: 'glm-4.5-air' },
    ];
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

function fromCache(provider: string): BackendChoice[] | undefined {
  const c = remoteCache.get(provider.toLowerCase());
  return c && c.length ? c : undefined;
}

/** Sync lookup used by adapters / inject. Prefer calling refreshBackendChoices first. */
export function backendChoices(provider: string): BackendChoice[] {
  return fromEnv(provider) || fromConfigFile(provider) || fromCache(provider) || defaults(provider);
}

/** Claude-style agent tier aliases (Task/subagent `model: "haiku"` etc.). */
export type AgentTier = 'opus' | 'sonnet' | 'haiku' | 'fable';

/**
 * Detect a Claude (or generic) tier alias in a model id string.
 * Matches bare names (`haiku`), full Claude ids (`claude-haiku-4-5-…`), and
 * wrapped ASX ids (`claude-asx-…haiku…`).
 */
export function detectAgentTier(id?: string): AgentTier | undefined {
  if (!id) return undefined;
  const s = id.toLowerCase();
  // Order matters: check more specific / less ambiguous names first.
  if (/\bhaiku\b/.test(s)) return 'haiku';
  if (/\bfable\b/.test(s)) return 'fable';
  if (/\bsonnet\b/.test(s)) return 'sonnet';
  if (/\bopus\b/.test(s)) return 'opus';
  return undefined;
}

/**
 * Pick a backend choice for an agent tier from the available list.
 * Prefers low-effort / fast variants for haiku so subagents stay on models the
 * account can actually call (same family as default when possible).
 */
export function pickTierChoice(list: BackendChoice[], tier: AgentTier): BackendChoice {
  if (!list.length) return { id: 'asx-proxy', model: 'asx-proxy' };
  const find = (pred: (c: BackendChoice) => boolean) => list.find(pred);

  if (tier === 'haiku') {
    // Fast/cheap: prefer explicit low effort on the default family, then air/mini/fast names.
    // Do NOT prefer luna/preview small models first — they often 404 while Sol works.
    return find((c) => c.effort === 'low' && /sol|gpt-5\.5|default/i.test(c.model + c.id))
      || find((c) => c.effort === 'low')
      || find((c) => /(?:^|[-_.])(air|mini|fast|flash|haiku)(?:$|[-_.])/i.test(c.id))
      || find((c) => /low/i.test(c.id))
      || list[Math.min(2, list.length - 1)]
      || list[0];
  }
  if (tier === 'sonnet') {
    return find((c) => c.effort === 'medium' && /sol|gpt-5\.5/i.test(c.model + c.id))
      || find((c) => c.effort === 'medium')
      || find((c) => /terra|sonnet|medium/i.test(c.id))
      || list[Math.min(1, list.length - 1)]
      || list[0];
  }
  if (tier === 'fable') {
    return find((c) => c.effort === 'xhigh' || c.effort === 'max' || c.effort === 'ultra')
      || find((c) => /xhigh|max|ultra|fable/i.test(c.id))
      || list[0];
  }
  // opus — flagship high
  return find((c) => c.effort === 'high' && /sol|opus|gpt-5\.5/i.test(c.model + c.id))
    || find((c) => c.effort === 'high')
    || list[0];
}

// Map an agent-requested id back to a concrete choice.
// Order: exact id/model match → Claude tier alias (haiku/sonnet/…) → default (first).
export function resolveChoice(provider: string, id?: string): BackendChoice {
  const list = backendChoices(provider);
  if (!list.length) return { id: 'asx-proxy', model: 'asx-proxy' };
  if (id) {
    const exact = list.find((c) => c.id === id || c.model === id);
    if (exact) return exact;
    // Claude wraps non-claude ids as claude-asx-<id>; strip if still present.
    const stripped = id.startsWith('claude-asx-') ? id.slice('claude-asx-'.length) : id;
    if (stripped !== id) {
      const exact2 = list.find((c) => c.id === stripped || c.model === stripped);
      if (exact2) return exact2;
    }
    const tier = detectAgentTier(id) || detectAgentTier(stripped);
    if (tier) {
      const picked = pickTierChoice(list, tier);
      dlog(`[asx-models] ${provider}: alias '${id}' → tier=${tier} → ${picked.id} (${picked.model}${picked.effort ? '/' + picked.effort : ''})`);
      return picked;
    }
  }
  return list[0];
}

export type RefreshModelsOpts = {
  /** Raw stored secret (Grok auth.json wrapper / bare JWT, or ZAI API key). */
  credential?: string;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
};

/**
 * Populate the remote model cache for a backend provider (when env/file do not pin the list).
 * Safe to call repeatedly; failures leave the previous cache / defaults intact.
 */
export async function refreshBackendChoices(
  provider: string,
  opts: RefreshModelsOpts = {},
): Promise<BackendChoice[]> {
  const p = provider.toLowerCase();
  // Explicit overrides always win — do not hit the network.
  const pinned = fromEnv(p) || fromConfigFile(p);
  if (pinned) {
    remoteCache.set(p, pinned);
    return pinned;
  }

  try {
    const remote = await fetchRemoteChoices(p, opts);
    if (remote?.length) {
      remoteCache.set(p, remote);
      dlog(`[asx-models] ${p}: loaded ${remote.length} model(s) from API → ${remote.map((c) => c.id).join(', ')}`);
      return remote;
    }
  } catch (e: any) {
    dlog(`[asx-models] ${p}: remote fetch failed: ${e?.message || e}`);
  }
  return backendChoices(p);
}

/** Test helper: clear remote cache between cases. */
export function clearRemoteModelCache(): void {
  remoteCache.clear();
}

async function fetchRemoteChoices(
  provider: string,
  opts: RefreshModelsOpts,
): Promise<BackendChoice[] | undefined> {
  if (provider === 'grok' || provider === 'xai') return fetchGrokModels(opts);
  if (provider === 'zai') return fetchZaiModels(opts);
  return undefined;
}

// --- Grok CLI cloud ----------------------------------------------------------
// GET https://cli-chat-proxy.grok.com/v1/models
// Auth: Bearer <OIDC access token> + X-XAI-Token-Auth / client version headers
// (same as chat). Each entry may advertise reasoning_efforts[]; we expand those
// into picker rows (grok-4.5-high / -medium / -low) so Codex/Claude can switch.

function grokTokenFromCred(cred: string | undefined): string | null {
  if (!cred) return null;
  try {
    const d = JSON.parse(cred);
    const e = d[Object.keys(d)[0]];
    const key = e?.key || d.key;
    if (typeof key === 'string' && key) return key;
  } catch { /* bare JWT */ }
  return cred || null;
}

function grokAuthHeaders(token: string): Record<string, string> {
  const version = getGrokVersion();
  return {
    Authorization: `Bearer ${token}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': version,
    'x-grok-client-identifier': 'grok-shell',
    'User-Agent': `grok-shell/${version} (macos; aarch64)`,
  };
}

/** Expand a Grok /v1/models entry into one or more BackendChoice rows. */
export function grokModelsToChoices(data: any[]): BackendChoice[] {
  const out: BackendChoice[] = [];
  for (const m of data || []) {
    if (!m) continue;
    const model = typeof m.model === 'string' && m.model ? m.model
      : typeof m.id === 'string' && m.id ? m.id
      : null;
    if (!model) continue;
    const baseId = typeof m.id === 'string' && m.id ? m.id : model;
    const efforts: string[] = Array.isArray(m.reasoning_efforts)
      ? m.reasoning_efforts
        .map((e: any) => e?.value || e?.id)
        .filter((e: any): e is string => typeof e === 'string' && !!e)
      : [];
    if (m.supports_reasoning_effort && efforts.length) {
      // Default effort first so list[0] is the natural default for inject/proxy.
      const ordered = [...efforts].sort((a, b) => {
        const aDef = m.reasoning_efforts?.find((e: any) => (e.value || e.id) === a)?.default;
        const bDef = m.reasoning_efforts?.find((e: any) => (e.value || e.id) === b)?.default;
        return (bDef ? 1 : 0) - (aDef ? 1 : 0);
      });
      for (const effort of ordered) {
        out.push({ id: `${baseId}-${effort}`, model, effort });
      }
    } else {
      out.push({ id: baseId, model });
    }
  }
  return out;
}

async function fetchGrokModels(opts: RefreshModelsOpts): Promise<BackendChoice[] | undefined> {
  const token = grokTokenFromCred(opts.credential);
  if (!token) {
    dlog('[asx-models] grok: no credential, skip remote models');
    return undefined;
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl('https://cli-chat-proxy.grok.com/v1/models', {
    headers: grokAuthHeaders(token),
  });
  if (!res.ok) {
    dlog(`[asx-models] grok: /v1/models -> ${res.status}`);
    return undefined;
  }
  const body: any = await res.json().catch(() => null);
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
  if (!list?.length) return undefined;
  const choices = grokModelsToChoices(list);
  return choices.length ? choices : undefined;
}

// --- Z.AI coding API ---------------------------------------------------------
// GET https://api.z.ai/api/coding/paas/v4/models  Authorization: Bearer <key>

async function fetchZaiModels(opts: RefreshModelsOpts): Promise<BackendChoice[] | undefined> {
  const key = opts.credential?.trim();
  if (!key) return undefined;
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl('https://api.z.ai/api/coding/paas/v4/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    dlog(`[asx-models] zai: /models -> ${res.status}`);
    return undefined;
  }
  const body: any = await res.json().catch(() => null);
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
  if (!list?.length) return undefined;
  const out: BackendChoice[] = [];
  for (const m of list) {
    const id = m?.id || m?.model;
    if (typeof id !== 'string' || !id) continue;
    // Keep thinking models as effort-tagged defaults when the name looks like glm-5.x
    if (/^glm-5/i.test(id) && !/air/i.test(id)) {
      out.push({ id, model: id, effort: 'high' });
    } else {
      out.push({ id, model: id });
    }
  }
  return out.length ? out : undefined;
}
