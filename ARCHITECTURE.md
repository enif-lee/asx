# Architecture

ASX is a small CLI that separates credential ownership from agent execution.

The core path is:

```text
provider native auth or API key
  -> ASX vault profile
  -> isolated agent runtime
  -> optional ASX Proxy when agent wire and backend provider differ
```

## Core Terms

```text
Provider
  A credential/backend family such as claude, codex, grok, or zai.

Profile
  One named ASX account under a provider.
  Stored as: provider + name + credential + metadata.

Agent
  The native CLI process ASX launches, such as codex, claude, or grok.

Backend
  The upstream provider that receives the final model request.
```

Provider and profile are related like this:

```text
Provider: codex
  Profile: personal.codex
  Profile: work.codex

Provider: zai
  Profile: personal.zai

Provider: claude
  Profile: personal.claude
  Profile: max.claude
```

The profile chooses the credential. The optional target argument chooses the launched agent.

```text
asx e personal.zai codex
      ^ profile      ^ target agent

profile provider = zai
agent provider   = codex
backend provider = zai
```

## Main Layers

### CLI

`src/cli.ts` owns command parsing and user-facing flows.

Main commands:

- `load`: snapshot the current native provider credential into ASX.
- `login`: run a provider login flow and store the result.
- `switch`: write a stored credential back to the provider's native location.
- `exec` / `e`: run an agent with an isolated profile.
- `proxy`: expose a standalone ASX Proxy endpoint.

The CLI does orchestration only. Provider-specific credential rules live in provider adapters.

### Storage

ASX keeps secrets and metadata separate.

- `src/storage/secure-store.ts` stores credentials by `${provider}:${name}`.
- `src/storage/account-store.ts` stores account metadata, labels, email, and active markers.

```text
ASX config dir
  accounts.json
    - provider, name, label, email, addedAt
  .active.json
    - provider -> active profile name
  vault.json
    - "provider:name" -> raw credential
```

The credential vault is a `0600` file by default:

```text
<platform config dir>/asx/vault.json
```

On macOS, legacy keychain vaults are migrated into the file vault. Setting `ASX_KEYCHAIN=1` also writes the vault to keychain, but the file remains the default source of truth.

### Provider Adapters

Provider adapters implement `ProviderAdapter` from `src/providers/base.ts`.

Common responsibilities:

- `loadCurrent(name)`: read the live provider credential and store it in ASX.
- `switchTo(name)`: make a stored profile active for normal native provider use.
- `getCurrentCredential()`: read the live provider credential for `list` matching.
- `getUsage(name)`: return displayable quota or usage text.
- `refresh(name)`: rotate expiring stored credentials when the provider supports it.
- `login(name)`: handle providers with no native CLI login, such as ZAI API keys.
- `getLoginCommand()`: return a native login command for providers with native auth.

Current provider mapping:

- `claude`: `src/providers/claude-code.ts`
- `codex`: `src/providers/codex.ts`
- `grok`: `src/providers/key-adapter.ts`
- `zai`: `src/providers/key-adapter.ts`
- `cursor`: `src/providers/cursor.ts`

## Credential Flows

### Claude

Claude native login is isolated by setting `CLAUDE_CONFIG_DIR` to a profile-scoped runtime directory before running `claude auth login`.

Normal Claude profiles store access/refresh credentials. Claude long-lived profiles store a wrapper containing `CLAUDE_CODE_OAUTH_TOKEN`; `exec` injects that value into the spawned process.

Native Claude credentials use a stable profile-scoped runtime directory so concurrent Claude sessions for the same ASX profile share Claude's own credential file.

### Codex

Codex reads and writes `auth.json` under `CODEX_HOME`.

ASX snapshots `CODEX_HOME/auth.json`, stores it in the vault, and writes it into an isolated `CODEX_HOME` during `exec` when isolation or proxy routing is needed.

### Grok

Grok native login runs `grok login`.

ASX snapshots the full `auth.json` under `GROK_HOME` or `~/.grok`, preserving the issuer wrapper. `switch` writes the stored Grok auth back to `auth.json`.

For usage and proxy calls, ASX extracts the bearer token from either the full Grok auth wrapper or a bare token.

### ZAI

ZAI has no native agent login in ASX. `asx login zai` asks for an API key, verifies it with:

```text
GET https://api.z.ai/api/coding/paas/v4/models
```

Then it stores the key in the ASX vault.

`asx load zai` can also read `ZAI_API_KEY` or `ZAI_KEY` from the environment.

## Isolated Execution

`asx exec <profile> [target?]` chooses two providers:

- profile provider: where the stored credential comes from.
- agent provider: which native binary is launched.

If no target is passed, both are the profile provider.

If a target is passed, ASX launches the target agent and uses the profile provider as the backend through ASX Proxy.

Examples:

```text
asx e personal.codex
  profile=codex, agent=codex, backend=codex

asx e personal.zai codex
  profile=zai, agent=codex, backend=zai
```

Agent runtime isolation is controlled through provider home env vars:

- Codex: `CODEX_HOME`
- Claude: `CLAUDE_CONFIG_DIR`
- Grok: `GROK_HOME`

### Same-Provider Execution

When profile provider and agent provider are the same, ASX runs the native tool with that profile's credential.

```text
asx e personal.codex

ASX vault
  "codex:personal.codex"
        |
        v
isolated CODEX_HOME/auth.json
        |
        v
codex CLI
        |
        v
Codex upstream
```

No ASX Proxy is needed because the launched agent already speaks the backend provider's native wire format.

### Cross-Provider Execution

When profile provider and agent provider differ, ASX starts a local proxy.

```text
asx e personal.zai codex

ASX vault
  "zai:personal.zai"
        |
        v
ASX Proxy backend credential

isolated CODEX_HOME/config.toml
  base_url = http://127.0.0.1:<port>/v1
  model_provider = "asx-proxy"
  model = "glm-5.2"
        |
        v
codex CLI
        |
        |  Codex Responses wire
        v
ASX Proxy
        |
        |  ZAI OpenAI-compatible chat completions wire
        v
ZAI upstream
```

In this mode:

- The profile provider supplies the credential.
- The target agent supplies the local UX and request wire format.
- The proxy converts between the agent wire and backend wire.
- The native agent never receives the real backend credential directly.

## ASX Proxy

ASX Proxy is a local in-process HTTP proxy used when the launched agent wire differs from the stored backend credential.

The proxy shape is:

```text
native agent
  |
  | provider-native request
  v
agent adapter
  |
  | COMMON request
  v
backend adapter
  |
  | upstream provider request
  v
provider upstream
  |
  | upstream stream
  v
backend adapter
  |
  | COMMON events
  v
agent adapter
  |
  | provider-native response stream
  v
native agent
```

Files:

- `src/proxy/server.ts`: local HTTP server and request routing.
- `src/proxy/types.ts`: COMMON request, response, and adapter contracts.
- `src/proxy/inject.ts`: writes temp config/env so native agents point at ASX Proxy.
- `src/proxy/models.ts`: backend model choices shown to the launched agent.
- `src/proxy/adapters/*`: agent/backend wire adapters.

`GET /models` and `GET /v1/models` return the backend model choices. This lets Codex and Grok display backend-specific model choices during cross-provider runs.

### Proxy Adapter Matrix

```text
             incoming agent wire       outgoing backend wire
codex        Responses API             ChatGPT Codex Responses API
claude       Anthropic Messages API     Anthropic Messages API
grok         Chat Completions API       Grok CLI cloud API
zai          n/a                        ZAI Chat Completions API
```

`zai` is backend-only because ASX does not launch a native ZAI agent.

## Adding a Provider

For credential management:

1. Add a `ProviderAdapter` implementation in `src/providers`.
2. Register it in `src/providers/index.ts`.
3. Add focused tests for load, login, switch, usage, or refresh behavior.

For proxy backend support:

1. Add a backend adapter in `src/proxy/adapters`.
2. Register it in `src/proxy/adapters/index.ts`.
3. Add default model choices in `src/proxy/models.ts`.
4. Add adapter tests and, if needed, injection/server tests.

For a new native agent frontend:

1. Add an agent adapter in `src/proxy/adapters`.
2. Register it in `src/proxy/adapters/index.ts`.
3. Add an `AGENT_SPEC` entry in `src/cli.ts`.
4. Add injection support in `src/proxy/inject.ts`.

Keep provider behavior local to the provider or proxy adapter. Avoid adding provider-specific branches to shared CLI flow unless the provider really has a different lifecycle.
