import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setSecret, getSecret } from '../storage/secure-store.js';
import { addAccount, getAccount } from '../storage/account-store.js';
import { getClaudeCredentialsPath, getPlatform, ensureDirFor } from '../utils/platform.js';
import type { ProviderAdapter } from './base.js';
import { renderBar } from '../utils/bar.js';





async function extractClaudeEmail(credJson: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(credJson);
    const token = parsed?.claudeAiOauth?.accessToken || parsed?.accessToken;
    if (!token) return undefined;

    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!res.ok) return undefined;
    const data: any = await res.json();
    return data?.email_address || data?.email || data?.account?.email_address || data?.account?.email || data?.email;
  } catch {
    return undefined;
  }
}

const PROVIDER = 'claude';

function readCurrentCredentials(): string | null {
  const plat = getPlatform();
  if (plat === 'darwin') {
    try {
      // Common service names used by Claude Code
      const services = ['Claude Code-credentials', 'Claude Code - credentials', 'claude-code-credentials'];
      for (const svc of services) {
        try {
          const out = execSync(`security find-generic-password -s ${JSON.stringify(svc)} -w`, {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
          }).trim();
          if (out) return out;
        } catch {}
      }
    } catch {}
    return null;
  }
  // Linux / Win file
  const p = getClaudeCredentialsPath();
  if (fs.existsSync(p)) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  }
  return null;
}

function writeActiveCredentials(raw: string): void {
  const plat = getPlatform();
  if (plat === 'darwin') {
    const account = process.env.USER || 'user';
    // Write under the service claude actually reads
    const svc = 'Claude Code-credentials';
    try {
      execSync(`security add-generic-password -s ${JSON.stringify(svc)} -a ${JSON.stringify(account)} -w ${JSON.stringify(raw)} -U`, { stdio: 'ignore' });
    } catch (e) {
      // fallback to our store only
      console.error('Warning: failed to write Claude Keychain item directly');
    }
    return;
  }

  // non-mac: write the credentials file (0600)
  const p = getClaudeCredentialsPath();
  ensureDirFor(p);
  fs.writeFileSync(p, raw);
  try { fs.chmodSync(p, 0o600); } catch {}
}

async function fetchOAuthUsage(token: string): Promise<any | null> {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        // Some clients include this beta header; it is optional but harmless
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const claudeCodeAdapter: ProviderAdapter = {
  name: PROVIDER,

  async loadCurrent(accountName: string, label?: string) {
    const current = readCurrentCredentials();
    if (!current) {
      throw new Error('No active Claude Code credentials found. Login with `claude` (or `claude auth login`) first, then run `asx load claude <name>`.');
    }
    const email = await extractClaudeEmail(current);
    await setSecret(PROVIDER, accountName, current, { email, label: label || accountName });

    addAccount({
      provider: PROVIDER,
      name: accountName,
      label: label || accountName,
      email,
    });
  },

  async switchTo(accountName: string) {
    const stored = await getSecret(PROVIDER, accountName);
    if (!stored) throw new Error(`No credentials stored for ${PROVIDER}/${accountName}. Use 'asx load' first.`);
    writeActiveCredentials(stored);
    // update lightweight active marker
    const { setActive } = await import('../storage/account-store.js');
    setActive(PROVIDER, accountName);
  },

  async getCurrent() {
    const raw = readCurrentCredentials();
    return raw ? 'active (token present)' : null;
  },

  async getCurrentCredential() {
    return readCurrentCredentials();
  },

  async getCurrentEmail() {
    const current = readCurrentCredentials();
    if (!current) return undefined;
    return extractClaudeEmail(current);
  },

  async clearCurrent() {
    const plat = getPlatform();
    if (plat === 'darwin') {
      const account = process.env.USER || 'user';
      const services = ['Claude Code-credentials', 'Claude Code - credentials', 'claude-code-credentials'];
      for (const svc of services) {
        try {
          execSync(`security delete-generic-password -s ${JSON.stringify(svc)} -a ${JSON.stringify(account)}`, { stdio: 'ignore' });
        } catch {}
      }
      return;
    }
    const p = getClaudeCredentialsPath();
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  },

  getLoginCommand() {
    return ['claude', 'auth', 'login'];
  },

  async getUsage(accountName?: string) {
    try {
      const raw = await getSecret(PROVIDER, accountName || '');
      if (!raw) return 'No stored credential for this account.';

      const data = JSON.parse(raw);
      const oauth = data?.claudeAiOauth || {};
      const tier = oauth.rateLimitTier || 'unknown';
      const subType = oauth.subscriptionType || 'unknown';

      const namePart = accountName ? ` (${accountName})` : '';

      const token = oauth.accessToken;
      let baseInfo = `subscription=${subType} tier=${tier}${namePart}`;

      if (token) {
        try {
          const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
            headers: { 'Authorization': `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
          });
          if (res.ok) {
            const prof: any = await res.json();
            const org = prof.organization || {};
            const acc = prof.account || {};
            const orgType = org.organization_type || org.billing_type || '';
            const hasMax = acc.has_claude_max || org.has_claude_max ? 'yes' : 'no';
            baseInfo = `subscription=${subType} tier=${tier} org=${orgType} has_max=${hasMax}${namePart}`;
          }
        } catch {}
      }
      // Prefer the official OAuth usage endpoint that Claude Code itself uses
      // (this is what powers /usage and /status inside the CLI).
      // It uses the per-account accessToken, so it reports the correct quota
      // for the specific stored account without depending on browser login.
      let extra = '';
      if (token) {
        const usage = await fetchOAuthUsage(token);
        if (usage) {
          const f = usage.five_hour || usage.fiveHour;
          const s = usage.seven_day || usage.sevenDay;
          if (f && typeof f.utilization === 'number') {
            const used5 = Math.max(0, Math.min(100, f.utilization));
            const rem5 = Math.max(0, 100 - used5);
            let resetNote = '';
            if (f.resets_at) {
              try { resetNote = ' (resets ~' + new Date(f.resets_at).toISOString().slice(11,16) + 'Z)'; } catch {}
            }
            extra += `\n  5h: ${renderBar(rem5)} ${rem5.toFixed(1)}% / ${used5.toFixed(1)}%${resetNote}`;
          }
          if (s && typeof s.utilization === 'number') {
            const used7 = Math.max(0, Math.min(100, s.utilization));
            const rem7 = Math.max(0, 100 - used7);
            extra += `\n  7d: ${renderBar(rem7)} ${rem7.toFixed(1)}% / ${used7.toFixed(1)}%`;
          }
        }
      }

      // Last resort: local token summing estimate (inaccurate for shared plans)
      if (!extra) {
        try {
          const recent = await computeRecentClaudeUsage();
          const baseMax5h = 1000000;
          const scale5 = tier.includes('20x') ? 100 : (tier.includes('max') ? 20 : 1);
          const max5h = baseMax5h * scale5;
          const pct5 = Math.min(100, (recent.fiveHour / max5h) * 100);
          const rem5 = Math.max(0, 100 - pct5);
          extra += `\n  5h: ${renderBar(rem5)} ${rem5.toFixed(1)}% / ${pct5.toFixed(1)}%`;
          const baseMax7d = 5000000;
          const scale7 = tier.includes('20x') ? 100 : (tier.includes('max') ? 20 : 1);
          const max7d = baseMax7d * scale7;
          const pct7 = Math.min(100, (recent.sevenDay / max7d) * 100);
          const rem7 = Math.max(0, 100 - pct7);
          extra += `\n  7d: ${renderBar(rem7)} ${rem7.toFixed(1)}% / ${pct7.toFixed(1)}%`;
        } catch {}
      }

      return baseInfo + extra;
    } catch (e) {
      return 'Unable to read usage info from stored credential.';
    }
  },
};

async function computeRecentClaudeUsage(): Promise<{ fiveHour: number; sevenDay: number }> {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return { fiveHour: 0, sevenDay: 0 };

  const now = Date.now();
  let five = 0;
  let seven = 0;
  const cutoff5 = now - 5 * 60 * 60 * 1000;
  const cutoff7 = now - 7 * 24 * 60 * 60 * 1000;

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && full.endsWith('.jsonl')) {
        try {
          const lines = fs.readFileSync(full, 'utf8').trim().split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            const d = JSON.parse(line);
            if (d.type !== 'assistant' || !d.message || !d.message.usage) continue;
            const tsStr = d.timestamp;
            const ts = tsStr ? new Date(tsStr).getTime() : 0;
            if (!ts) continue;
            const u = d.message.usage;
            const t = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.reasoning_tokens || 0);
            if (ts > cutoff5) five += t;
            if (ts > cutoff7) seven += t;
          }
        } catch {}
      }
    }
  }

  walk(root);
  return { fiveHour: five, sevenDay: seven };
}
