# asx

**Multi-account switcher for LLM coding tools.**

Store credentials securely in a single OS Keychain vault and switch between accounts instantly.

## ✨ Features

- **Single Vault**: All accounts (across providers) stored in one secure entry using OS Keychain (`cross-keychain` + fallbacks).
- **Instant Switch**: `asx cc work` or `asx switch claude-code personal` updates the active credentials so `claude`, `codex`, etc. see the right account immediately.
- **Beautiful Usage**: Live quota reporting with consistent progress bars (`bar(remaining%) / used%`).
  - Claude Code: accurate 5h / 7d via official OAuth usage API
  - Codex: 5h / 7d windows via ChatGPT backend
  - Grok / xAI / Z.AI: credits + rate limits
- **Shortcuts**: `cc`, `cx`, `gk`, `cs`
- **Scoped Execution**: `asx run personal -- claude "explain this"`
- **Convenient Auto-Add**: `asx add` (or `asx add <provider>`) auto-detects current sessions for main providers (claude-code, codex, grok, cursor). Names are globally unique and optional (defaults to email local part or "personal").
- **Provider-less Commands**: `asx run <name>`, `asx remove <name>` work without provider.
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

# Auto-add current sessions (or specify provider)
asx add
asx add claude-code work
asx add codex personal

# Switch using shortcuts
asx cc work           # claude-code
asx gk personal       # grok

# See what's active
asx status

# Check usage (with nice bars)
asx usage

# Run a command with a specific account (no provider needed)
asx run personal -- claude "refactor this function"
```

## 📋 Commands

| Command                  | Description                              |
|--------------------------|------------------------------------------|
| `asx list [provider]`    | List accounts (or for one provider)      |
| `asx add [provider] [name]` | Auto-add (or for specific provider); name optional |
| `asx switch <provider> <name>` | Switch active account                 |
| `asx cc [name]`          | Shortcut: claude-code cycle/switch       |
| `asx cx [name]`          | Shortcut: codex                          |
| `asx gk [name]`          | Shortcut: grok                           |
| `asx cs [name]`          | Shortcut: cursor                         |
| `asx usage [provider] [name]` | Show live quota with bars (name optional) |
| `asx status [provider]`  | Show currently active accounts           |
| `asx run <name> -- <cmd...>` | Run command with account (provider resolved by unique name) |
| `asx remove <name>` | Remove account (provider optional if name unique) |

## 🛠 Supported Providers

| Provider     | Identifier     | Auth                  | Usage                  |
|--------------|----------------|-----------------------|------------------------|
| Claude Code  | `claude-code`  | Keychain (real)       | 5h / 7d bars (accurate)|
| Codex        | `codex`        | `~/.codex/auth.json`  | 5h / 7d windows        |
| Grok / xAI   | `grok`         | API Key               | Credits + rate limits  |
| Z.AI         | `zai`          | API Key               | Basic key info         |
| Cursor       | `cursor`       | Tracked (limited)     | Metadata only          |

More providers can be added easily via the adapter pattern.

## 🔐 How It Works

- Everything is stored in **one** secure vault item (`service=asx`, `account=vault`).
- When you `add`, asx reads the currently active credential from the provider's storage (Keychain for Claude, auth.json for Codex, etc.) and saves it in the vault together with email.
- `switch` writes the chosen credential back to the provider's expected location so the native CLI picks it up.
- Usage uses the same live mechanisms as [openusage](https://github.com/janekbaraniewski/openusage) where possible (OAuth for Claude, backend APIs for others).

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
