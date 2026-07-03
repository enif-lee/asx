import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectProxyEndpoint } from './inject.js';

describe('injectProxyEndpoint', () => {
  it('sets Codex default model from backend choices', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-inject-'));
    const env: NodeJS.ProcessEnv = {};
    try {
      await injectProxyEndpoint('codex', env, 'http://127.0.0.1:1234', tmp, 'zai');

      const config = fs.readFileSync(path.join(tmp, 'codex', 'config.toml'), 'utf8');
      expect(config).toContain('model = "glm-5.2"');
      expect(config).toContain('model_provider = "asx-proxy"');
      expect(config).toContain('model_catalog_json = ');
      expect(config).toContain('env_key = "ASX_PROXY_API_KEY"');
      expect(config).toContain('requires_openai_auth = false');
      const catalog = JSON.parse(fs.readFileSync(path.join(tmp, 'codex', 'models.json'), 'utf8'));
      expect(catalog.models[0]).toMatchObject({ slug: 'glm-5.2', display_name: 'glm-5.2', provider: 'asx-proxy', hidden: false });
      expect(env.ASX_PROXY_API_KEY).toBe('asx-proxy-dummy');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('remaps Claude built-in model slots to backend models and disables gateway discovery', async () => {
    const env: NodeJS.ProcessEnv = {};
    await injectProxyEndpoint('claude', env, 'http://127.0.0.1:9999', undefined, 'codex');
    // gateway discovery must be OFF (we remap slots instead of appending a gateway section)
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined();
    // codex backend choices are gpt-5.5-high/medium/low/xhigh -> opus/sonnet/haiku/fable slots
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-5.5-high');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBe('gpt-5.5-high');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.5-medium');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.5-low');
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('gpt-5.5-xhigh');
    // default session model is the first backend model, not Claude's Opus
    expect(env.ANTHROPIC_MODEL).toBe('gpt-5.5-high');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999');
  });
});
