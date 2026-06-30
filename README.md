# asx

**Multi-account switcher for LLM coding tools.**

Store credentials securely in a single OS Keychain vault and switch between accounts instantly.

## ✨ Features

- **Single Vault**: All accounts (across providers) stored in one secure entry using OS Keychain (`cross-keychain` + fallbacks).
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
- **Convenient Load + Login**: `asx load` snapshots the currently active credential. `asx login <provider>` saves the current session without expiring it, clears only the local state, runs the native login flow, then loads the new account. This enables clean multi-account use without token revocation.
- **Provider-less Commands**: `asx exec <name>`, `asx remove <name>` work without provider (name is globally unique or resolved).
- **Email Tracking**: Stores associated email when loading accounts.
- **Cross-platform**: Strong support on macOS, works on Linux/Windows.

## 📦 Installation

```bash
# From source (recommended while in development)
git clone https://github.com/enif-lee/asx.git
cd asx
npm install
npm link
```

Or build and install globally:

```bash
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

# Better multi-account flow (saves existing without expiry)
asx login codex work
asx login claude

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
```

## 📋 Commands

| Command                  | Description |
|--------------------------|-------------|
| `asx list [provider] [-u/-d]` | List accounts. `-u/--usage` shows live quota bars. `-d/--debug` dumps stored credentials. Marks the live system credential with `(current in system)`. |
| `asx load [provider] [name]` | Snapshot the currently active credential(s) from the provider into asx. Auto-generates name like `ed.claude` / `ed.codex` if omitted. |
| `asx login <provider> [name]` | Save current session (non-destructive), clear local only, launch native login, then load the new one. |
| `asx rename <from> <to>` | Rename an account (updates vault + metadata + active markers). |
| `asx switch <provider> <name>` (alias: `s`) | Switch the active credential for a provider. |
| `asx status [provider]` | Show asx-tracked active account(s). |
| `asx exec <name> [args...]` (alias: `e`) | Run the native CLI under an **isolated** profile. Creates a temp credential copy (unless it is already the current profile). `-b/--bypass` auto-injects full access flags. Use `--` to cleanly pass options to the native tool. |
| `asx remove [provider] <name>` (alias: `rm`) | Remove a stored account. |

## 🛠 Supported Providers

| Provider     | Identifier     | Auth                                           | Usage                     |
|--------------|----------------|------------------------------------------------|---------------------------|
| Claude Code  | `claude`       | Keychain (macOS) or `~/.claude/.credentials.json` | 5h / 7d bars (accurate)   |
| Codex        | `codex`        | `~/.codex/auth.json` (respects `$CODEX_HOME`)     | 5h / 7d windows           |
| Grok / xAI   | `grok`         | `~/.grok/auth.json` (respects `$GROK_HOME`)       | Credits + rate limits     |
| Z.AI         | `zai`          | Environment variable                              | Basic key info            |
| Cursor       | `cursor`       | Metadata only (limited)                           | Metadata only             |

More providers can be added easily via the adapter pattern.

## 🔐 How It Works

- Everything is stored in **one** secure vault item (`service=asx`, `account=vault`).
- `asx load` (or `asx login`) reads the currently active credential from the provider's storage (keychain / `~/.codex/auth.json` / `~/.grok/auth.json` etc.) and saves it in the vault (with email).
- `asx login <provider>` first snapshots the existing session (without calling logout), clears only the *local* credential, then runs the native login flow and loads the new one. This prevents token expiry on the previous account.
- `switch` (or `s`) writes the chosen credential back to the provider's native location so the native CLI sees it.
- `exec` / `e` runs the native CLI **isolated** from other terminals:
  - If the profile is already the current asx active one → execute the native binary directly.
  - Otherwise → write a copy of the credential into a temp directory, set `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `GROK_HOME` etc., spawn the native tool, and delete the temp dir on exit.
  - `-b / --bypass` automatically injects the appropriate full-access flags for the provider.
- `list` (and `list -u`) detects the *live* credential currently loaded in the system (keychain/auth files) and annotates the matching stored account with `(current in system)`.
- Usage bars (via `list -u`) use the same live mechanisms as [openusage](https://github.com/janekbaraniewski/openusage) where possible.

## 🖥️ Development

```bash
npm run dev          # run with tsx
npm run build        # tsc + chmod
npm test
```

## 📄 License

MIT

---

Made with ❤️ for people who live in multiple LLM accounts. 

> Tip: Combine with `openusage` for beautiful terminal dashboards!
