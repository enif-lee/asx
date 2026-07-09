import os from 'node:os';
import path from 'node:path';
import fs, { existsSync } from 'node:fs';

export type Platform = 'darwin' | 'win32' | 'linux' | 'other';

export function getPlatform(): Platform {
  const p = os.platform();
  if (p === 'darwin') return 'darwin';
  if (p === 'win32') return 'win32';
  if (p === 'linux') return 'linux';
  return 'other';
}

export function isMac(): boolean { return getPlatform() === 'darwin'; }

function expandHome(p: string): string {
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function getConfigBaseDir(): string {
  const plat = getPlatform();
  if (plat === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (plat === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  // Linux / other -> XDG or ~/.config
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

export function getHomeDotDir(name: string): string {
  // ~/.name  (common for claude, codex, grok, etc.)
  return path.join(os.homedir(), `.${name}`);
}

// === Claude Code ===
export function getClaudeConfigDir(): string {
  // CLAUDE_CONFIG_DIR overrides the base (affects credentials on non-mac)
  if (process.env.CLAUDE_CONFIG_DIR) {
    return expandHome(process.env.CLAUDE_CONFIG_DIR);
  }
  return getHomeDotDir('claude');
}

export function getClaudeCredentialsPath(): string {
  const base = getClaudeConfigDir();
  // On mac the real creds are in Keychain; this path is used on Linux/Win (and as fallback)
  return path.join(base, '.credentials.json');
}

// === Codex ===
export function getCodexHome(): string {
  if (process.env.CODEX_HOME) return expandHome(process.env.CODEX_HOME);
  return getHomeDotDir('codex');
}

export function getCodexAuthPath(): string {
  return path.join(getCodexHome(), 'auth.json');
}

// === Grok ===
export function getGrokHome(): string {
  if (process.env.GROK_HOME) return expandHome(process.env.GROK_HOME);
  return getHomeDotDir('grok');
}

export function getGrokAuthPath(): string {
  return path.join(getGrokHome(), 'auth.json');
}

// === Pi coding agent (https://pi.dev) ===
// Config lives under PI_CODING_AGENT_DIR (default ~/.pi/agent): auth.json, models.json, sessions/, …
export function getPiAgentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return expandHome(process.env.PI_CODING_AGENT_DIR);
  return path.join(getHomeDotDir('pi'), 'agent');
}

export function getPiAuthPath(): string {
  return path.join(getPiAgentDir(), 'auth.json');
}


// Generic helper to ensure parent dir
export function ensureDirFor(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getAsxConfigDir(): string {
  // Our own config dir for metadata (not secrets)
  const base = getConfigBaseDir();
  return path.join(base, 'asx');
}

export function getAsxAccountsPath(): string {
  return path.join(getAsxConfigDir(), 'accounts.json');
}

// Persistent per-profile home directories live here. Isolated agent profiles use
// this as the native CLI home (CODEX_HOME/CLAUDE_CONFIG_DIR/GROK_HOME). Claude on
// macOS stores the OAuth secret in the matching hashed Keychain service.
export function getAsxProfilesDir(): string {
  return path.join(getAsxConfigDir(), 'profiles');
}

// Read the installed grok CLI version from ~/.grok/version.json, with a fallback
// to a recent pinned version if the file is missing or unreadable. Used so the
// proxy/backend headers (x-grok-client-version, User-Agent) match the real binary.
export function getGrokVersion(): string {
  try {
    const vp = path.join(getGrokHome(), 'version.json');
    if (existsSync(vp)) {
      const d = JSON.parse(fs.readFileSync(vp, 'utf8'));
      const v = d.version || d.stable_version;
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {}
  return '0.2.77'; // stale-but-recent fallback; bump if the proxy ever rejects it
}
