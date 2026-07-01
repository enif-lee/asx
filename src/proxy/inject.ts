import fs from 'node:fs';
import path from 'node:path';
import { dlog } from '../utils/log.js';
import { backendChoices } from './models.js';

// Inject proxy endpoint into the isolated temp environment so the *native binary*
// (codex or claude) talks to our local ASX proxy instead of real provider.
// backendProvider = the profile provider; its selectable models are shown to the agent.

export async function injectProxyEndpoint(
  sourceProvider: string,
  env: NodeJS.ProcessEnv,
  proxyBaseUrl: string, // e.g. http://127.0.0.1:18742
  tmpDir?: string,
  backendProvider?: string
): Promise<void> {
  const prov = sourceProvider.toLowerCase();
  const choices = backendChoices(backendProvider || prov);

  if (prov === 'codex') {
    await injectCodexProxy(tmpDir, proxyBaseUrl, env);
  } else if (prov.includes('claude')) {
    await injectClaudeProxy(env, proxyBaseUrl);
  } else if (prov === 'grok') {
    await injectGrokProxy(tmpDir, proxyBaseUrl, env, choices.map((c) => c.id));
  }
}

async function injectCodexProxy(tmpDir: string | undefined, proxyBaseUrl: string, env: NodeJS.ProcessEnv) {
  // Determine the private CODEX_HOME we control
  let codexHome = env.CODEX_HOME as string | undefined;
  if (!codexHome && tmpDir) {
    codexHome = path.join(tmpDir, 'codex');
  }
  if (!codexHome) {
    // Last resort: use a temp dir just for this injection
    const fs = await import('node:fs');
    const os = await import('node:os');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-codex-proxy-'));
    codexHome = path.join(temp, 'codex');
    env.CODEX_HOME = codexHome;
  }

  env.CODEX_HOME = codexHome; // always expose it (exec seeds it too; standalone prints it)
  const cfgPath = path.join(codexHome, 'config.toml');
  fs.mkdirSync(codexHome, { recursive: true });

  const providerId = 'asx-proxy';
  // Important: Codex expects base_url to point to the root where /v1 or /responses lives.
  // We follow opencodex convention: base_url ends with /v1, wire_api=responses.
  const base = proxyBaseUrl.replace(/\/+$/, '');

  // A clean, aggressive config that forces the proxy provider.
  // We overwrite the file with a minimal reliable content for this isolated run.
  const cleanConfig = `# ASX Proxy injected config for cross-provider execution
# This file is inside a private CODEX_HOME for this run only.
model_provider = "${providerId}"

[model_providers.${providerId}]
name = "ASX Proxy"
base_url = "${base}/v1"
wire_api = "responses"
requires_openai_auth = true
`;

  try {
    fs.writeFileSync(cfgPath, cleanConfig, { mode: 0o600 });

    dlog(`[asx-proxy] Injected Codex config at ${cfgPath}`);
    dlog(`[asx-proxy] base_url=${base}/v1  (model_provider=${providerId})`);
  } catch (e: any) {
    dlog('[asx proxy] failed to inject codex config.toml:', e?.message || e);
  }
}

async function injectClaudeProxy(env: NodeJS.ProcessEnv, proxyBaseUrl: string) {
  // Claude Code respects ANTHROPIC_BASE_URL for all model calls.
  // We point it at our proxy. Auth is handled inside proxy using target cred.
  env.ANTHROPIC_BASE_URL = proxyBaseUrl.replace(/\/$/, '');
  // Provide a dummy or proxy-accepted token. Real target key is in proxy.
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_AUTH_TOKEN = 'asx-proxy-token';
  }
  // Also help openai-shim paths if claude is in shim mode
  env.OPENAI_BASE_URL = proxyBaseUrl;
}

async function injectGrokProxy(tmpDir: string | undefined, proxyBaseUrl: string, env: NodeJS.ProcessEnv, models: string[]) {
  let grokHome = env.GROK_HOME as string | undefined;
  if (!grokHome && tmpDir) {
    grokHome = path.join(tmpDir, 'grok');
  }
  if (!grokHome) {
    const fsMod = await import('node:fs');
    const os = await import('node:os');
    const temp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'asx-grok-proxy-'));
    grokHome = path.join(temp, 'grok');
    env.GROK_HOME = grokHome;
  }

  env.GROK_HOME = grokHome; // always expose it (exec seeds it too; standalone prints it)
  fs.mkdirSync(grokHome, { recursive: true });

  const base = proxyBaseUrl.replace(/\/+$/, '');

  // Custom-model config (verified grok 0.2.x schema). grok appends /chat/completions to base_url,
  // so base_url must include /v1. api_key here is a dummy; real backend auth lives in the proxy.
  // permission_mode=always-approve + api_key means headless `grok -p` needs no login/auth.json.
  // One entry per selectable backend model — grok's picker (Ctrl+M, /model, `-m`) lists them all;
  // the chosen id is sent back and the proxy maps it to the real upstream. Keys are quoted since
  // model ids contain dots, which are TOML table-path separators otherwise.
  const list = models.length ? models : ['asx-proxy'];
  const entries = list.map((m) => `[model."${m}"]
model = "${m}"
base_url = "${base}/v1"
name = "${m}"
api_backend = "chat_completions"
api_key = "asx-proxy-dummy"
context_window = 200000
`).join('\n');
  const configContent = `# ASX Proxy injected config for cross-provider execution
[models]
default = "${list[0]}"

[ui]
permission_mode = "always-approve"

${entries}`;

  const cfgPath = path.join(grokHome, 'config.toml');
  try {
    fs.writeFileSync(cfgPath, configContent, { mode: 0o600 });
    dlog(`[asx-proxy] Injected Grok config at ${cfgPath}`);
    dlog(`[asx-proxy] base_url=${base} models=[${list.join(', ')}]`);
  } catch (e: any) {
    dlog('[asx proxy] failed to inject grok config.toml:', e?.message || e);
  }
}
