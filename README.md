# asx

> Multi-account switcher for LLM coding tools.  
> (formerly `as` — renamed to avoid conflict with the system assembler)

**Store credentials securely in a single OS Keychain vault and switch between accounts instantly.**

## ✨ Features

- **Single Vault**: All accounts (across providers) stored in one secure entry using OS Keychain (`cross-keychain` + fallbacks).
- **Instant Switch**: `asx cc work` or `asx switch claude-code personal` updates the active credentials so `claude`, `codex`, etc. see the right account immediately.
- **Beautiful Usage**: Live quota reporting with consistent progress bars (`bar(remaining%) / used%`).
  - Claude Code: accurate 5h / 7d via official OAuth usage API
  - Codex: 5h / 7d windows via ChatGPT backend
  - Grok / xAI / Z.AI: credits + rate limits
- **Shortcuts**: `cc`, `cx`, `gk`, `cs`
- **Scoped Execution**: `asx run grok personal -- claude "explain this"`
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

# Add accounts (login with the real tool first, then snapshot)
asx add claude-code work
asx add claude-code personal
asx add codex personal
asx add grok personal

# Switch
asx cc work           # shortcut for claude-code
asx gk personal       # grok

# See what's active
asx status

# Check usage (with nice bars)
asx usage

# Run a command with a specific account
asx run claude-code work -- claude "refactor this function"
```

## 📋 Commands

| Command                  | Description                              |
|--------------------------|------------------------------------------|
| `asx list [provider]`    | List accounts (or for one provider)      |
| `asx add <provider> <name>` | Add current logged-in account         |
| `asx switch <provider> <name>` | Switch active account                 |
| `asx cc [name]`          | Shortcut: claude-code cycle/switch       |
| `asx cx [name]`          | Shortcut: codex                          |
| `asx gk [name]`          | Shortcut: grok                           |
| `asx cs [name]`          | Shortcut: cursor                         |
| `asx usage [provider]`   | Show live quota with bars                |
| `asx status [provider]`  | Show currently active accounts           |
| `asx run <provider> <name> -- <cmd...>` | Run command with specific account |
| `asx remove <provider> <name>` | Remove stored account                |

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
