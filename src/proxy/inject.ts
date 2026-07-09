import fs from 'node:fs';
import path from 'node:path';
import { dlog } from '../utils/log.js';
import { backendChoices, refreshBackendChoices } from './models.js';
import { getAsxProfilesDir } from '../utils/platform.js';
import { codexModelInfo } from './adapters/codex.js';

// Last-resort scratch home for the injected native config when the caller did not
// provide a home. Both real callers (exec, `asx proxy`) always pass one, so this is
// a defensive fallback kept under the asx config dir (never /tmp).
function fallbackAgentHome(provider: string): string {
  const dir = path.join(getAsxProfilesDir(), '.agents', `${provider}-adhoc`);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

// Inject proxy endpoint into the isolated temp environment so the *native binary*
// (codex or claude) talks to our local ASX proxy instead of real provider.
// backendProvider = the profile provider; its selectable models are shown to the agent.
// When backendCredential is set, we refresh the model list from the provider API first
// (Grok /v1/models, Z.AI /models) so the agent picker is not stuck on hardcoded defaults.

export async function injectProxyEndpoint(
  sourceProvider: string,
  env: NodeJS.ProcessEnv,
  proxyBaseUrl: string, // e.g. http://127.0.0.1:18742
  tmpDir?: string,
  backendProvider?: string,
  backendCredential?: string,
): Promise<void> {
  const prov = sourceProvider.toLowerCase();
  const backend = (backendProvider || prov).toLowerCase();
  if (backendCredential) {
    await refreshBackendChoices(backend, { credential: backendCredential });
  }
  const choices = backendChoices(backend);

  if (prov === 'codex') {
    await injectCodexProxy(tmpDir, proxyBaseUrl, env, choices.map((c) => c.id));
  } else if (prov.includes('claude')) {
    await injectClaudeProxy(env, proxyBaseUrl, choices.map((c) => c.id));
  } else if (prov === 'grok') {
    await injectGrokProxy(tmpDir, proxyBaseUrl, env, choices.map((c) => c.id));
  } else if (prov === 'pi') {
    await injectPiProxy(tmpDir, proxyBaseUrl, env, choices.map((c) => c.id));
  }
}

async function injectCodexProxy(tmpDir: string | undefined, proxyBaseUrl: string, env: NodeJS.ProcessEnv, models: string[]) {
  // Determine the private CODEX_HOME we control
  let codexHome = env.CODEX_HOME as string | undefined;
  if (!codexHome && tmpDir) {
    codexHome = path.join(tmpDir, 'codex');
  }
  if (!codexHome) {
    codexHome = fallbackAgentHome('codex');
    env.CODEX_HOME = codexHome;
  }

  env.CODEX_HOME = codexHome; // always expose it (exec seeds it too; standalone prints it)
  const cfgPath = path.join(codexHome, 'config.toml');
  const catalogPath = path.join(codexHome, 'models.json');
  fs.mkdirSync(codexHome, { recursive: true });

  const providerId = 'asx-proxy';
  const model = models[0] || 'asx-proxy';
  // Important: Codex expects base_url to point to the root where /v1 or /responses lives.
  // We follow opencodex convention: base_url ends with /v1, wire_api=responses.
  const base = proxyBaseUrl.replace(/\/+$/, '');
  env.ASX_PROXY_API_KEY = env.ASX_PROXY_API_KEY || 'asx-proxy-dummy';

  // A clean, aggressive config that forces the proxy provider.
  // We overwrite the file with a minimal reliable content for this isolated run.
  const cleanConfig = `# ASX Proxy injected config for cross-provider execution
# This file is inside a private CODEX_HOME for this run only.
model = ${JSON.stringify(model)}
model_provider = "${providerId}"
model_catalog_json = ${JSON.stringify(catalogPath)}
model_context_window = 200000
model_auto_compact_token_limit = 160000
model_supports_reasoning_summaries = false
model_reasoning_summary = "none"

[model_providers.${providerId}]
name = "ASX Proxy"
base_url = "${base}/v1"
env_key = "ASX_PROXY_API_KEY"
wire_api = "responses"
requires_openai_auth = false
`;

  try {
    fs.writeFileSync(catalogPath, JSON.stringify({
      models: models.map((m, i) => codexModelInfo(m, i, { provider: providerId, hidden: false })),
    }, null, 2), { mode: 0o600 });
    fs.writeFileSync(cfgPath, cleanConfig, { mode: 0o600 });

    dlog(`[asx-proxy] Injected Codex config at ${cfgPath}`);
    dlog(`[asx-proxy] base_url=${base}/v1  (model_provider=${providerId})`);
  } catch (e: any) {
    dlog('[asx proxy] failed to inject codex config.toml:', e?.message || e);
  }
}

// Claude Code's built-in Opus/Sonnet/Haiku/Fable model slots (there are exactly these four).
const CLAUDE_MODEL_SLOTS = ['OPUS', 'SONNET', 'HAIKU', 'FABLE'];

async function injectClaudeProxy(env: NodeJS.ProcessEnv, proxyBaseUrl: string, models: string[]) {
  // Claude Code respects ANTHROPIC_BASE_URL for all model calls.
  // We point it at our proxy. Auth is handled inside proxy using target cred.
  env.ANTHROPIC_BASE_URL = proxyBaseUrl.replace(/\/$/, '');
  // Provide a dummy or proxy-accepted token. Real target key is in proxy.
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_AUTH_TOKEN = 'asx-proxy-token';
  }
  // Claude Code hardcodes its Opus/Sonnet/Haiku picker rows and offers no way to hide them; gateway
  // discovery would only *append* backend models alongside them. So instead we REMAP the built-in
  // slots onto the backend models (id + display name) and leave gateway discovery OFF. Result: the
  // /model picker shows Default + the backend models only, with real names — no Claude names.
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  models.slice(0, CLAUDE_MODEL_SLOTS.length).forEach((m, i) => {
    const slot = CLAUDE_MODEL_SLOTS[i];
    env[`ANTHROPIC_DEFAULT_${slot}_MODEL`] = m;             // raw backend id; the proxy resolves it
    env[`ANTHROPIC_DEFAULT_${slot}_MODEL_NAME`] = m;        // shown in the picker
    env[`ANTHROPIC_DEFAULT_${slot}_MODEL_DESCRIPTION`] = 'via asx proxy';
  });
  if (models.length > CLAUDE_MODEL_SLOTS.length) {
    dlog(`[asx-proxy] ${models.length - CLAUDE_MODEL_SLOTS.length} extra backend model(s) not shown (Claude has only ${CLAUDE_MODEL_SLOTS.length} model slots)`);
  }
  // Default the session to the first backend model instead of Claude's built-in Opus.
  if (models[0] && !env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = models[0];
  // Also help openai-shim paths if claude is in shim mode
  env.OPENAI_BASE_URL = proxyBaseUrl;
}

async function injectGrokProxy(tmpDir: string | undefined, proxyBaseUrl: string, env: NodeJS.ProcessEnv, models: string[]) {
  let grokHome = env.GROK_HOME as string | undefined;
  if (!grokHome && tmpDir) {
    grokHome = path.join(tmpDir, 'grok');
  }
  if (!grokHome) {
    grokHome = fallbackAgentHome('grok');
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

// Pi coding agent (https://pi.dev) — config under PI_CODING_AGENT_DIR (default ~/.pi/agent).
// Cross-provider: write models.json with a single custom provider that speaks OpenAI Chat
// Completions to the ASX proxy, plus settings.json defaultProvider/defaultModel so print
// mode picks it without --provider flags.
async function injectPiProxy(
  tmpDir: string | undefined,
  proxyBaseUrl: string,
  env: NodeJS.ProcessEnv,
  models: string[],
): Promise<void> {
  let agentDir = env.PI_CODING_AGENT_DIR as string | undefined;
  if (!agentDir && tmpDir) agentDir = path.join(tmpDir, 'pi-agent');
  if (!agentDir) {
    agentDir = fallbackAgentHome('pi');
  }
  env.PI_CODING_AGENT_DIR = agentDir;
  fs.mkdirSync(agentDir, { recursive: true });
  try { fs.chmodSync(agentDir, 0o700); } catch {}

  const base = proxyBaseUrl.replace(/\/+$/, '');
  // Pi openai-completions clients append paths like /chat/completions to baseUrl;
  // ASX proxy serves those under /v1/… so baseUrl must include /v1.
  const baseUrl = `${base}/v1`;
  const list = models.length ? models : ['asx-proxy'];
  const defaultModel = list[0];

  const modelsDoc = {
    providers: {
      'asx-proxy': {
        baseUrl,
        api: 'openai-completions',
        apiKey: 'asx-proxy-dummy',
        authHeader: true,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: false,
        },
        models: list.map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ['text'],
          contextWindow: 200000,
          maxTokens: 16384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
  };

  const settingsDoc = {
    defaultProvider: 'asx-proxy',
    defaultModel,
    // Avoid interactive trust prompts in isolated cross-provider homes.
    defaultProjectTrust: 'always',
  };

  try {
    const modelsPath = path.join(agentDir, 'models.json');
    const settingsPath = path.join(agentDir, 'settings.json');
    // Empty auth.json: models.json apiKey satisfies custom-provider auth for pi.
    const authPath = path.join(agentDir, 'auth.json');
    fs.writeFileSync(modelsPath, JSON.stringify(modelsDoc, null, 2), { mode: 0o600 });
    fs.writeFileSync(settingsPath, JSON.stringify(settingsDoc, null, 2), { mode: 0o600 });
    if (!fs.existsSync(authPath)) {
      fs.writeFileSync(authPath, '{}', { mode: 0o600 });
    }
    dlog(`[asx-proxy] Injected Pi models.json at ${modelsPath}`);
    dlog(`[asx-proxy] baseUrl=${baseUrl} defaultModel=${defaultModel} models=[${list.join(', ')}]`);
  } catch (e: any) {
    dlog('[asx proxy] failed to inject pi models.json:', e?.message || e);
  }
}
