# asx

<p align="center">
  <img src="docs/assets/asx-title.png" alt="asx - multi-account agent switcher" />
</p>

**Multi-account switcher for LLM coding tools.**

Store each profile's credential in its own `0600` home directory and switch between accounts instantly.

## ✨ Features

- **Multiple accounts, one workflow**: Keep work, personal, and team accounts for Claude Code, Codex, Grok, Z.AI, and other providers.
- **Fast account switching**: Make a saved profile active with `asx switch` and keep `asx list` honest about what is currently loaded.
- **One-off profile runs**: Run an agent with a selected profile without changing other terminals or your default login.
- **Cross-provider execution**: Use one agent UI with another provider backend, such as running Codex while routing requests to Claude, Grok, or Z.AI.
- **Usage at a glance**: Show live quota, credits, and rate-limit information with `asx list -u`.
- **Safer login management**: Save existing sessions before new logins, load current sessions into profiles, and keep each profile's credential in its own `0600` file.
- **Cross-platform installer**: Install from GitHub Releases on macOS, Linux, and Windows.

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

# Run under a profile-scoped home (other terminals unaffected)
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
| `asx list [provider] [-u/-d]` | List accounts and each profile's shared/isolated categories. `-u/--usage` shows live quota bars. `-d/--debug` dumps stored credentials. Marks the live system credential with `(current in system)`. |
| `asx load [provider] [name]` | Register the currently active credential as a **system profile**. Auto-generates name like `ed.claude` / `ed.codex` if omitted. |
| `asx login <provider> [name] [--long-lived] [share flags]` | Login and store a new isolated profile. If the target profile is current in system, login keeps the provider's normal home path. |
| `asx sharing <name> [share flags]` | Show or change what an isolated agent profile shares from its provider's system home. With no flags, prints the current setting. |
| `asx rename <from> <to>` | Rename an account (moves the profile home + updates metadata + active markers). |
| `asx switch <provider> <name>` (alias: `s`) | Switch the active credential for a provider. |
| `asx status [provider]` | Show asx-tracked active account(s). |
| `asx exec <name> [target?] [args...]` (alias: `e`) | Run the native CLI under a profile. When `target` differs from profile provider, requests are routed via local ASX Proxy (input→common→external schema transformers). `-b/--bypass` auto-injects full access flags. |
| `asx remove [provider] <name>` (alias: `rm`) | Remove a stored account. |

### Sharing flags (per profile)

Control what an isolated agent profile shares from the provider's system home (`~/.claude`, `~/.codex`, `~/.grok`). System profiles and backend-only profiles such as ZAI do not accept sharing flags. Default is **share everything supported by that provider**; only the credential is per-profile. Claude supports `sessions`, `skills`, `agents`, `hooks`, `settings`; Codex and Grok support `sessions`, `skills`, `settings`. Accepted by `asx login` and `asx sharing`:

| Flag | Effect |
|------|--------|
| `--shared` | Share all categories (the default). |
| `--isolated` | Fully isolate — share nothing; the profile gets its own history/settings. |
| `--share <a,b,...>` | Share only these categories; isolate the rest. |
| `--isolate <a,b,...>` | Share everything except these categories. |

## 🛠 Supported Providers

| Provider     | Identifier     | Auth                                           | Usage                     |
|--------------|----------------|------------------------------------------------|---------------------------|
| Claude Code  | `claude`       | Native access/refresh tokens in profile `CLAUDE_CONFIG_DIR`; optional long-lived `CLAUDE_CODE_OAUTH_TOKEN` | 5h / 7d bars (accurate)   |
| Codex        | `codex`        | `~/.codex/auth.json` (respects `$CODEX_HOME`)     | 5h / 7d windows           |
| Grok / xAI   | `grok`         | Native `grok login`; `~/.grok/auth.json` (respects `$GROK_HOME`) | Credits + rate limits     |
| Z.AI         | `zai`          | API key via `asx login zai`; `ZAI_API_KEY`/`ZAI_KEY` for `asx load` | 5h quota via monitor API  |
| Cursor       | `cursor`       | Metadata only (limited)                           | Metadata only             |

More providers can be added easily via the adapter pattern.

## 🔐 How It Works

### System Profiles vs Isolated Profiles

- A **system profile** is registered with `asx load`. It represents the provider's normal user-level home (`~/.claude`, `~/.codex`, `~/.grok`) and does not use sharing/isolation settings.
- An **isolated profile** is created with `asx login`. It owns a persistent home directory under the asx config dir (e.g. `~/Library/Application Support/asx/profiles/<provider>-<name>/`, `0700`). File-based providers store the credential there using the provider's native filename (`auth.json`, `.credentials.json`, ...). Claude on macOS stores OAuth credentials in the profile-specific Keychain service derived from that home path.
- Provider *native* state (your default login, used when you run the tool directly) is separate from asx profile homes:
  - Claude native credential: Claude Keychain item on macOS, `.credentials.json` on Linux/Windows.
  - Codex native credential: `~/.codex/auth.json`.
  - Grok native credential: `~/.grok/auth.json`.
  - ZAI: no native agent state; asx stores the API key in the profile home.
- `asx load` reads the currently active provider-native credential and registers it as a system profile.
- `asx switch` writes a stored profile back to provider-native state when the provider has one. ZAI only updates asx's active marker and process env for the current command.

### Login And Execution

- `asx login claude [name]` runs `claude auth login` with `CLAUDE_CONFIG_DIR` pointed at the isolated profile home. On macOS, ASX reads/writes the matching `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[:8]>` Keychain entry; on Linux/Windows, it uses `.credentials.json`. If `[name]` is current in system, it keeps the normal Claude home path and updates that credential instead.
- `asx login claude [name] --long-lived` runs `claude setup-token`, asks for the long-lived token, and stores it in the profile home for `CLAUDE_CODE_OAUTH_TOKEN` execution.
- `asx login codex [name]` and `asx login grok [name]` run the native login flow inside the isolated profile home unless `[name]` is current in system.
- `asx login zai [name]` asks for an API key, validates it with `GET https://api.z.ai/api/coding/paas/v4/models`, then stores it in the profile home.
- Claude long-lived token profiles only update asx's active marker on `switch`; `exec` injects `CLAUDE_CODE_OAUTH_TOKEN`.
- `exec` / `e` keeps system profiles on the provider's normal home path. For isolated profiles it injects the provider's home env var (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME`) to point at the isolated profile home.
  - Session history and shared setup (`projects`/`sessions`/`history`, plus provider-supported `skills`/`agents`/`hooks`/`settings`) are **symlinked** from the provider's system home (`~/.claude`, `~/.codex`, `~/.grok`) into isolated agent profiles. Backend-only profiles do not participate.
  - Cross-provider runs launch the agent binary under a fresh per-run context home, route real requests through the local ASX Proxy using the profile's backend credential, then delete that context when the agent exits. Cross context options are consumed before agent args: `-s`/`--shared`, `-i`/`--isolated`, `--share <categories>`, `--isolate <categories>`, `--keep-context`. Use `--` to force later args through to the agent.
  - `-b / --bypass` automatically injects the appropriate full-access flags for the provider.
- `list` (and `list -u`) detects the *live* credential currently loaded in the system (native keychain/auth files) and annotates the matching stored account with `(current in system)`.

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
