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
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
