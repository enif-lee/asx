# asx

**Multi-account switcher for LLM coding tools.**

Store credentials securely in the platform keychain and switch between accounts instantly.

## ✨ Features

- **Single Vault**: All account credentials are stored in one platform keychain vault (`cross-keychain` + native fallbacks). A `0600` file vault is used only when keychain storage is unavailable.
- **Instant Switch**: `asx switch claude personal` (or `asx s claude personal`) updates the active credentials so `claude`, `codex`, etc. see the right account immediately.
- **List shows live system state**: `asx list` marks the profile that currently matches the live credential in the system (keychain / auth files) with `(current in system)`.
- **Beautiful Usage**: Live quota reporting with consistent progress bars (`bar(remaining%) / used%`).
  - Claude Code: accurate 5h / 7d via official OAuth usage API
  - Codex: 5h / 7d windows via ChatGPT backend
  - Grok / xAI / Z.AI: credits + rate limits
- **Isolated Execution**: `asx exec <name>` (alias `e`) runs the native tool using a temporary credential copy (via `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME` etc.). Other terminals are unaffected. When the profile is already the current active one, it runs directly against the live storage. Temp files are automatically cleaned up on exit.
  - `-b, --bypass`: Automatically injects full-access bypass flags for the provider:
    - claude/grok: `--dangerously-skip-permissions`
    - codex: `--dangerously-bypass-approvals-and-sandbox` + `--dangerously-bypass-hook-trust`
- **Convenient Load + Login**: `asx load` snapshots the currently active credential. `asx login claude` uses Claude's native access/refresh token flow inside an isolated `CLAUDE_CONFIG_DIR`; add `--long-lived` to store a `CLAUDE_CODE_OAUTH_TOKEN` instead.
- **Provider-less Commands**: `asx exec <name>`, `asx remove <name>` work without provider (name is globally unique or resolved).
- **Email Tracking**: Stores associated email when loading accounts.
- **Cross-platform**: Strong support on macOS, works on Linux/Windows.

## 📦 Installation

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/enif-lee/asx/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/enif-lee/asx/main/install.ps1 | iex
```

The installer downloads the latest GitHub Release package. If Node.js with `npm` or `pnpm` is not available, it installs Node.js LTS first.

Development install:

```bash
npm install
npm run build
npm install -g .
```

## 🚀 Quick Start

```bash
# List accounts
asx list

# Load current active sessions
asx load
asx load claude work
asx load codex personal

# Better multi-account flow (saves existing sessions before login)
asx login codex work
asx login claude work
asx login claude personal --long-lived
asx login grok work
asx login zai work

# Switch
asx switch claude personal
# or the short alias
asx s codex work

# See what's active + usage + live system state
asx list
asx list -u

# Run under an isolated profile (other terminals unaffected)
asx e ed.codex "refactor this function"

# Run with automatic full-access bypass for the provider
asx e ed.codex -b "do dangerous things"

# Cross-provider via ASX Proxy (profile provider != target agent)
# e.g. run Codex CLI but route through Claude, Grok, or ZAI backend
asx e ed.codex claude "refactor using claude"
asx e ed.claude xai "explain with grok"
asx e personal.zai codex "use ZAI through Codex UI"
```

## 📋 Commands

| Command                  | Description |
|--------------------------|-------------|
| `asx list [provider] [-u/-d]` | List accounts. `-u/--usage` shows live quota bars. `-d/--debug` dumps stored credentials. Marks the live system credential with `(current in system)`. |
| `asx load [provider] [name]` | Snapshot the currently active credential(s) from the provider into asx. Auto-generates name like `ed.claude` / `ed.codex` if omitted. |
| `asx login <provider> [name] [--long-lived]` | Login and store a new account. Claude defaults to native access/refresh tokens in isolated `CLAUDE_CONFIG_DIR`; Grok runs native `grok login`; ZAI asks for an API key and tests the endpoint; `--long-lived` uses `claude setup-token`. |
| `asx rename <from> <to>` | Rename an account (updates vault + metadata + active markers). |
| `asx switch <provider> <name>` (alias: `s`) | Switch the active credential for a provider. |
| `asx status [provider]` | Show asx-tracked active account(s). |
| `asx exec <name> [target?] [args...]` (alias: `e`) | Run the native CLI under an **isolated** profile. When `target` differs from profile provider, requests are routed via local ASX Proxy (input→common→external schema transformers). `-b/--bypass` auto-injects full access flags. |
| `asx remove [provider] <name>` (alias: `rm`) | Remove a stored account. |

## 🛠 Supported Providers

| Provider     | Identifier     | Auth                                           | Usage                     |
|--------------|----------------|------------------------------------------------|---------------------------|
| Claude Code  | `claude`       | Native access/refresh tokens in isolated `CLAUDE_CONFIG_DIR`; optional long-lived `CLAUDE_CODE_OAUTH_TOKEN` | 5h / 7d bars (accurate)   |
| Codex        | `codex`        | `~/.codex/auth.json` (respects `$CODEX_HOME`)     | 5h / 7d windows           |
| Grok / xAI   | `grok`         | Native `grok login`; `~/.grok/auth.json` (respects `$GROK_HOME`) | Credits + rate limits     |
| Z.AI         | `zai`          | API key via `asx login zai`; `ZAI_API_KEY`/`ZAI_KEY` for `asx load` | 5h quota via monitor API  |
| Cursor       | `cursor`       | Metadata only (limited)                           | Metadata only             |

More providers can be added easily via the adapter pattern.

## 🔐 How It Works

### ASX Vault vs Native Provider State

- ASX stores profile credentials in **one** platform keychain vault item (`service=asx`, `account=vault`). A `0600` file vault is used only as fallback when keychain storage is unavailable.
- Provider native state is separate from the ASX vault:
  - Claude native credential: Claude Keychain item on macOS, `.credentials.json` on Linux/Windows.
  - Codex native credential: `CODEX_HOME/auth.json`.
  - Grok native credential: `GROK_HOME/auth.json`.
  - ZAI native credential: no native agent state; ASX stores the API key.
- `asx load` reads the currently active provider-native credential and saves a profile copy in the ASX vault.
- `asx switch` writes a stored profile back to provider-native state when the provider has one. ZAI only updates ASX's active marker and process env for the current command.

### Login And Execution

- `asx login claude [name]` runs `claude auth login` with a profile-scoped `CLAUDE_CONFIG_DIR`, then stores the resulting access/refresh credential in the asx vault without touching Claude's global Keychain credential.
- `asx login claude [name] --long-lived` runs `claude setup-token`, asks for the long-lived token, and stores it in the asx vault for `CLAUDE_CODE_OAUTH_TOKEN` execution.
- `asx login codex [name]` and `asx login grok [name]` first snapshot the existing session, clear only the provider-native credential, run the native login flow, then load the new credential.
- `asx login zai [name]` asks for an API key, validates it with `GET https://api.z.ai/api/coding/paas/v4/models`, then stores it in the ASX vault.
- Claude long-lived token profiles only update ASX's active marker on `switch`; `exec` injects `CLAUDE_CODE_OAUTH_TOKEN`.
- `exec` / `e` runs the native CLI **isolated** from other terminals:
  - Claude native access/refresh profiles use a stable profile-scoped runtime `CLAUDE_CONFIG_DIR` so concurrent sessions share Claude's own credential file.
  - Other isolated runs write a copy of the credential into a temp directory, set `CODEX_HOME` / `GROK_HOME` etc., spawn the native tool, and delete the temp dir on exit.
  - `-b / --bypass` automatically injects the appropriate full-access flags for the provider.
- `list` (and `list -u`) detects the *live* credential currently loaded in the system (keychain/auth files) and annotates the matching stored account with `(current in system)`.

## 🖥️ Development

```bash
npm run dev          # run with tsx
npm run build        # tsc + chmod
npm test
```

Developer guide: [Adding an Agent or Provider](docs/ADDING_AGENT_OR_PROVIDER.md)

Release:

```bash
gh workflow run "Publish Release" -f version=0.1.0
```

## 📄 License

MIT

---

Made with ❤️ for people who live in multiple LLM accounts. 
