import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backendChoices, resolveChoice } from './models.js';

const ENV = ['ASX_CODEX_MODELS', 'ASX_MODELS_CONFIG'];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

describe('backend model choices — external config injection', () => {
  it('defaults to the built-in codex list', () => {
    expect(backendChoices('codex').map((c) => c.id)).toContain('gpt-5.5-high');
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
