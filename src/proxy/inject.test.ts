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
    // codex backend first-four choices map onto Claude's opus/sonnet/haiku/fable slots
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-5.6-sol-high');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBe('gpt-5.6-sol-high');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-terra-medium');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.6-luna-medium');
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('gpt-5.6-sol-xhigh');
    // default session model is the first backend model, not Claude's Opus
    expect(env.ANTHROPIC_MODEL).toBe('gpt-5.6-sol-high');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999');
  });

  it('exposes GPT-5.6 Sol/Terra/Luna in Pi models.json when backend is codex', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-inject-pi-codex-'));
    const env: NodeJS.ProcessEnv = {};
    try {
      await injectProxyEndpoint('pi', env, 'http://127.0.0.1:4242', tmp, 'codex');
      const models = JSON.parse(fs.readFileSync(path.join(env.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8'));
      const ids = models.providers['asx-proxy'].models.map((m: any) => m.id);
      expect(ids).toContain('gpt-5.6-sol-high');
      expect(ids).toContain('gpt-5.6-terra-medium');
      expect(ids).toContain('gpt-5.6-luna-medium');
      expect(ids).toContain('gpt-5.6-sol-ultra');
      expect(models.providers['asx-proxy'].baseUrl).toBe('http://127.0.0.1:4242/v1');
      const settings = JSON.parse(fs.readFileSync(path.join(env.PI_CODING_AGENT_DIR!, 'settings.json'), 'utf8'));
      expect(settings.defaultModel).toBe('gpt-5.6-sol-high');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exposes GPT-5.6 in Codex catalog when backend is codex', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-inject-codex-56-'));
    const env: NodeJS.ProcessEnv = {};
    try {
      await injectProxyEndpoint('codex', env, 'http://127.0.0.1:4242', tmp, 'codex');
      const config = fs.readFileSync(path.join(tmp, 'codex', 'config.toml'), 'utf8');
      expect(config).toContain('model = "gpt-5.6-sol-high"');
      const catalog = JSON.parse(fs.readFileSync(path.join(tmp, 'codex', 'models.json'), 'utf8'));
      const slugs = catalog.models.map((m: any) => m.slug);
      expect(slugs).toContain('gpt-5.6-sol-high');
      expect(slugs).toContain('gpt-5.6-terra-high');
      expect(slugs).toContain('gpt-5.6-luna-max');
      // GPT-5.6 effort ladder includes max/ultra in ModelInfo
      const sol = catalog.models.find((m: any) => m.slug === 'gpt-5.6-sol-high');
      expect(sol.supported_reasoning_levels.map((e: any) => e.effort)).toEqual(
        expect.arrayContaining(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writes Pi models.json + settings.json pointing at the ASX proxy (openai-completions)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-inject-pi-'));
    const env: NodeJS.ProcessEnv = {};
    try {
      await injectProxyEndpoint('pi', env, 'http://127.0.0.1:4242', tmp, 'zai');

      expect(env.PI_CODING_AGENT_DIR).toBeTruthy();
      const agentDir = env.PI_CODING_AGENT_DIR!;
      // Must stay under the ASX-controlled tmp tree, not ~/.pi/agent
      expect(agentDir.startsWith(tmp)).toBe(true);

      const models = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'));
      const provider = models.providers['asx-proxy'];
      expect(provider).toBeTruthy();
      expect(provider.baseUrl).toBe('http://127.0.0.1:4242/v1');
      expect(provider.api).toBe('openai-completions');
      expect(provider.apiKey).toBe('asx-proxy-dummy');
      expect(Array.isArray(provider.models)).toBe(true);
      expect(provider.models.length).toBeGreaterThan(0);
      expect(provider.models[0].id).toBe('glm-5.2'); // zai backend default first choice

      const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
      expect(settings.defaultProvider).toBe('asx-proxy');
      expect(settings.defaultModel).toBe('glm-5.2');

      // auth.json present (stub) so pi home is complete
      expect(fs.existsSync(path.join(agentDir, 'auth.json'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
