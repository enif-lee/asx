// Pi coding agent provider adapter (https://pi.dev).
// Pi stores multi-provider credentials in a single auth.json under
// PI_CODING_AGENT_DIR (default ~/.pi/agent). ASX snapshots the whole file as the
// profile secret — we do not try to split per-vendor keys inside it.
import fs from 'node:fs';
import { setSecret, getSecret } from '../storage/secure-store.js';
import { addAccount, setActive } from '../storage/account-store.js';
import { ensureDirFor, getPiAgentDir, getPiAuthPath } from '../utils/platform.js';
import type { ProviderAdapter } from './base.js';

function readSystemAuthRaw(): string | null {
  try {
    const p = getPiAuthPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    return raw.length ? raw : null;
  } catch {
    return null;
  }
}

function writeSystemAuth(raw: string): void {
  const p = getPiAuthPath();
  ensureDirFor(p);
  // Ensure agent dir exists with private perms
  try { fs.mkdirSync(getPiAgentDir(), { recursive: true, mode: 0o700 }); } catch {}
  fs.writeFileSync(p, raw, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
}

function summarizeAuth(raw: string | null): { label?: string; email?: string } {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    // auth.json is typically { "<provider>": { type, key/token, ... }, ... }
    const keys = Object.keys(data).filter((k) => k && typeof data[k] === 'object');
    if (!keys.length) return { label: 'empty' };
    // Prefer a known email field on any entry
    for (const k of keys) {
      const e = data[k];
      if (e && typeof e.email === 'string' && e.email) return { email: e.email, label: keys.join('+') };
    }
    return { label: keys.join('+') };
  } catch {
    return { label: 'auth.json' };
  }
}

export const piAdapter: ProviderAdapter = {
  name: 'pi',

  async loadCurrent(accountName: string, label?: string): Promise<void> {
    const raw = readSystemAuthRaw();
    if (!raw) {
      throw new Error(
        'No Pi auth found at ~/.pi/agent/auth.json (or $PI_CODING_AGENT_DIR/auth.json). ' +
        'Run `pi`, complete /login for a provider, then retry `asx load pi`.',
      );
    }
    await setSecret('pi', accountName, raw);
    const meta = summarizeAuth(raw);
    addAccount({
      provider: 'pi',
      name: accountName,
      label: label || meta.label || accountName,
      email: meta.email,
      profileType: 'system',
    });
    setActive('pi', accountName);
  },

  async switchTo(accountName: string): Promise<void> {
    const raw = await getSecret('pi', accountName);
    if (!raw) throw new Error(`No stored credential for pi/${accountName}`);
    writeSystemAuth(raw);
    setActive('pi', accountName);
  },

  async getCurrentCredential(): Promise<string | null> {
    return readSystemAuthRaw();
  },

  async getCurrentEmail(): Promise<string | undefined> {
    return summarizeAuth(readSystemAuthRaw()).email;
  },

  async clearCurrent(): Promise<void> {
    const p = getPiAuthPath();
    try {
      if (fs.existsSync(p)) fs.writeFileSync(p, '{}', { mode: 0o600 });
    } catch {}
  },

  // Pi authenticates interactively via /login inside the TUI; there is no
  // non-interactive `pi login` subcommand. Point users at load after /login.
  getLoginCommand(): string[] | null {
    return null;
  },

  async login(accountName: string, label?: string): Promise<void> {
    // Create an empty isolated auth shell so the profile home exists; user must
    // run `asx e <name>` / set PI_CODING_AGENT_DIR and use /login, then load.
    // For a guided path we still accept pasting a full auth.json via env.
    const fromEnv = process.env.PI_AUTH_JSON;
    if (fromEnv) {
      await setSecret('pi', accountName, fromEnv);
      const meta = summarizeAuth(fromEnv);
      addAccount({
        provider: 'pi',
        name: accountName,
        label: label || meta.label || accountName,
        email: meta.email,
        profileType: 'isolated',
      });
      setActive('pi', accountName);
      return;
    }
    throw new Error(
      'Pi has no non-interactive login. Run `pi`, complete `/login`, then `asx load pi <name>`. ' +
      'Or set PI_AUTH_JSON to a full auth.json string and retry `asx login pi <name>`.',
    );
  },
};
