import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backendChoices,
  resolveChoice,
  refreshBackendChoices,
  clearRemoteModelCache,
  grokModelsToChoices,
} from './models.js';

const ENV = ['ASX_CODEX_MODELS', 'ASX_GROK_MODELS', 'ASX_ZAI_MODELS', 'ASX_MODELS_CONFIG'];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  clearRemoteModelCache();
});

describe('backend model choices — external config injection', () => {
  it('defaults to the built-in codex list (GPT-5.6 family + 5.5 fallback)', () => {
    const ids = backendChoices('codex').map((c) => c.id);
    expect(ids[0]).toBe('gpt-5.6-sol-high'); // default / Claude opus slot
    expect(ids).toContain('gpt-5.6-sol-high');
    expect(ids).toContain('gpt-5.6-terra-medium');
    expect(ids).toContain('gpt-5.6-luna-medium');
    expect(ids).toContain('gpt-5.6-sol-xhigh');
    expect(ids).toContain('gpt-5.6-sol-ultra');
    expect(ids).toContain('gpt-5.5-high'); // still listed for compatibility
    // resolveChoice maps picker id → real upstream model + effort
    expect(resolveChoice('codex', 'gpt-5.6-sol-xhigh')).toEqual({
      id: 'gpt-5.6-sol-xhigh', model: 'gpt-5.6-sol', effort: 'xhigh',
    });
    expect(resolveChoice('codex', 'gpt-5.6-terra-high')).toEqual({
      id: 'gpt-5.6-terra-high', model: 'gpt-5.6-terra', effort: 'high',
    });
  });

  it('env ASX_<PROV>_MODELS overrides the list (model:effort)', () => {
    process.env.ASX_CODEX_MODELS = 'gpt-5.5:high,gpt-5.5:low';
    const c = backendChoices('codex');
    expect(c.map((x) => x.id)).toEqual(['gpt-5.5-high', 'gpt-5.5-low']);
    expect(c[0]).toEqual({ id: 'gpt-5.5-high', model: 'gpt-5.5', effort: 'high' });
  });

  it('config file overrides defaults; accepts strings and objects', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asx-models-')), 'models.json');
    fs.writeFileSync(f, JSON.stringify({
      codex: ['gpt-5.5:high', { id: 'fast', model: 'gpt-5.5', effort: 'low' }],
    }));
    process.env.ASX_MODELS_CONFIG = f;
    const c = backendChoices('codex');
    expect(c.map((x) => x.id)).toEqual(['gpt-5.5-high', 'fast']);
    // resolveChoice maps a custom id back to the real model + effort
    expect(resolveChoice('codex', 'fast')).toEqual({ id: 'fast', model: 'gpt-5.5', effort: 'low' });
  });

  it('env takes precedence over the config file', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asx-models-')), 'models.json');
    fs.writeFileSync(f, JSON.stringify({ codex: ['from-file'] }));
    process.env.ASX_MODELS_CONFIG = f;
    process.env.ASX_CODEX_MODELS = 'from-env';
    expect(backendChoices('codex').map((x) => x.id)).toEqual(['from-env']);
  });
});

describe('grokModelsToChoices', () => {
  it('expands reasoning_efforts into picker rows with default first', () => {
    const choices = grokModelsToChoices([
      {
        id: 'grok-4.5',
        model: 'grok-4.5',
        supports_reasoning_effort: true,
        reasoning_efforts: [
          { id: 'low', value: 'low', default: false },
          { id: 'high', value: 'high', default: true },
          { id: 'medium', value: 'medium', default: false },
        ],
      },
      { id: 'grok-composer-2.5-fast', model: 'grok-composer-2.5-fast' },
    ]);
    expect(choices.map((c) => c.id)).toEqual([
      'grok-4.5-high',
      'grok-4.5-low',
      'grok-4.5-medium',
      'grok-composer-2.5-fast',
    ]);
    expect(choices[0]).toEqual({ id: 'grok-4.5-high', model: 'grok-4.5', effort: 'high' });
    expect(choices[3]).toEqual({ id: 'grok-composer-2.5-fast', model: 'grok-composer-2.5-fast' });
  });
});

describe('refreshBackendChoices — remote Grok API', () => {
  it('loads models from /v1/models and caches them for backendChoices', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'grok-4.5',
            model: 'grok-4.5',
            supports_reasoning_effort: true,
            reasoning_efforts: [
              { id: 'high', value: 'high', default: true },
              { id: 'low', value: 'low', default: false },
            ],
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    ) as any;

    // Without refresh, default is hardcoded grok-build.
    expect(backendChoices('grok').map((c) => c.id)).toEqual(['grok-build']);

    const c = await refreshBackendChoices('grok', {
      credential: JSON.stringify({ 'https://auth.x.ai::x': { key: 'tok' } }),
      fetchImpl,
    });
    expect(c.map((x) => x.id)).toEqual(['grok-4.5-high', 'grok-4.5-low']);
    // Cache is visible to sync backendChoices / resolveChoice
    expect(backendChoices('grok').map((x) => x.id)).toEqual(['grok-4.5-high', 'grok-4.5-low']);
    expect(resolveChoice('grok', 'grok-4.5-low')).toEqual({ id: 'grok-4.5-low', model: 'grok-4.5', effort: 'low' });
  });

  it('does not call the API when ASX_GROK_MODELS is set', async () => {
    process.env.ASX_GROK_MODELS = 'pinned-model';
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response('nope', { status: 500 }); }) as any;
    const c = await refreshBackendChoices('grok', { credential: 'tok', fetchImpl });
    expect(c.map((x) => x.id)).toEqual(['pinned-model']);
    expect(calls).toBe(0);
  });

  it('falls back to defaults when fetch fails', async () => {
    const fetchImpl = (async () => { throw new Error('network down'); }) as any;
    const c = await refreshBackendChoices('grok', { credential: 'tok', fetchImpl });
    expect(c.map((x) => x.id)).toEqual(['grok-build']);
  });
});
