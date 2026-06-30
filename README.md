# asx

**Multi-account switcher for LLM coding tools.**

Store credentials securely in a single OS Keychain vault and switch between accounts instantly.

## ✨ Features

- **Single Vault**: All accounts (across providers) stored in one secure entry using OS Keychain (`cross-keychain` + fallbacks).
- **Instant Switch**: `asx switch claude personal` (or `asx s claude personal`) updates the active credentials so `claude`, `codex`, etc. see the right account immediately.
- **Beautiful Usage**: Live quota reporting with consistent progress bars (`bar(remaining%) / used%`).
  - Claude Code: accurate 5h / 7d via official OAuth usage API
  - Codex: 5h / 7d windows via ChatGPT backend
  - Grok / xAI / Z.AI: credits + rate limits
- **Isolated Execution (WIP)**: `asx exec` (alias `e`) runs the native tool with a disposable temp credential copy so other terminals are unaffected. When the profile is already current, it runs directly. Temp files are cleaned on exit. (See plan for details)
- **Convenient Load + Login**: `asx load` snapshots the currently active credential. `asx login <provider>` saves the current session without expiring it, clears only the local state, runs the native login flow, then loads the new account. This enables clean multi-account use without token revocation.
- **Provider-less Commands**: `asx exec <name>`, `asx remove <name>` work without provider.
- **Email Tracking**: Stores associated email when adding accounts.
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
asx load claude-code work
asx load codex personal

# Better multi-account flow (saves existing without expiry)
asx login codex work
asx login claude-code

# Switch
asx switch claude personal
# or the short alias
asx s codex work

# See what's active + usage
asx list
asx list -u

# Run with isolated profile (no impact on other terminals)
asx e personal "refactor this function" --permission=always-allow
```

## 📋 Commands

| Command                  | Description                              |
|--------------------------|------------------------------------------|
| `asx list [provider] [-u]` | List accounts (+ usage with -u/--usage) |
| `asx load [provider] [name]` | Snapshot currently active creds into asx. If no name given, auto-generates as `localpart.provider` (e.g. `e-ed.claude`) |
| `asx login <provider> [name]` | Save current, clear local, run native login, load new |
| `asx rename <from> <to>` | Rename an account (updates both vault and metadata) |
| `asx switch <provider> <name>` (or `s`) | Switch the active credential for a provider |
| `asx status [provider]`  | Show currently active accounts           |
| `asx exec <name> [prompt] [opts]` (alias: e) | Isolated native execution using temp credential (WIP) |
| `asx remove <name>` | Remove account (provider optional if name unique) |

## 🛠 Supported Providers

| Provider     | Identifier     | Auth                  | Usage                  |
|--------------|----------------|-----------------------|------------------------|
| Claude Code  | `claude`       | Keychain (real)       | 5h / 7d bars (accurate)|
| Codex        | `codex`        | `~/.codex/auth.json`  | 5h / 7d windows        |
| Grok / xAI   | `grok`         | API Key               | Credits + rate limits  |
| Z.AI         | `zai`          | API Key               | Basic key info         |
| Cursor       | `cursor`       | Tracked (limited)     | Metadata only          |

More providers can be added easily via the adapter pattern.

## 🔐 How It Works

- Everything is stored in **one** secure vault item (`service=asx`, `account=vault`).
- `asx load` (or `asx login`) reads the currently active credential from the provider's storage and saves it in the vault (with email).
- `asx login <provider>` first snapshots the existing session (without calling logout), clears only the *local* credential, then runs the native login flow and loads the new one. This prevents token expiry on the previous account.
- `switch` writes the chosen credential back to the provider's expected location so the native CLI picks it up.
- Usage (now via `list -u`) uses the same live mechanisms as [openusage](https://github.com/janekbaraniewski/openusage) where possible.

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
