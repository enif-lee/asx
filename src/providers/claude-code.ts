import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import { setSecret, getSecret } from '../storage/secure-store.js';
import { addAccount } from '../storage/account-store.js';
import { getClaudeCredentialsPath, getPlatform, ensureDirFor } from '../utils/platform.js';
import type { ProviderAdapter } from './base.js';
import { renderBar, formatReset } from '../utils/bar.js';





const PROVIDER = 'claude';
// Claude Code's public OAuth client id (used for the refresh_token grant).
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const LONG_LIVED_TOKEN_TYPE = 'claude-code-oauth-token';

export function normalizeClaudeCodeOAuthToken(input: string): string {
  let token = input.trim();
  const m = token.match(/^(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN=(.+)$/s);
  if (m) token = m[1].trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1);
  }
  return token.trim();
}

function makeLongLivedTokenCredential(token: string): string {
  return JSON.stringify({ type: LONG_LIVED_TOKEN_TYPE, token: normalizeClaudeCodeOAuthToken(token) });
}

export function getClaudeCodeOAuthToken(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.type === LONG_LIVED_TOKEN_TYPE && typeof parsed.token === 'string') return normalizeClaudeCodeOAuthToken(parsed.token);
    return parsed?.claudeAiOauth?.accessToken || parsed?.accessToken || null;
  } catch {
    return raw || null;
  }
}

export function isClaudeCodeLongLivedToken(raw: string): boolean {
  try {
    return JSON.parse(raw)?.type === LONG_LIVED_TOKEN_TYPE;
  } catch {
    return false;
  }
}

async function extractClaudeEmail(credJson: string): Promise<string | undefined> {
  try {
    const token = getClaudeCodeOAuthToken(credJson);
    if (!token) return undefined;

    const { status, data } = await fetchAnthropicJson('/api/oauth/profile', token);
    if (status < 200 || status >= 300 || !data) return undefined;
    return data?.email_address || data?.email || data?.account?.email_address || data?.account?.email || data?.email;
  } catch {
    return undefined;
  }
}

function readCurrentCredentials(): string | null {
  const filePath = getClaudeCredentialsPath();
  if (process.env.CLAUDE_CONFIG_DIR && fs.existsSync(filePath)) {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  }

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
  const p = filePath;
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

// Returns { status, data }. status 0 = network error. Non-2xx (esp. 401) means the
// stored token is expired/invalid — the caller must not fall back to stale local data.
async function fetchOAuthUsage(token: string): Promise<{ status: number; data: any | null; retryAfter?: string | null }> {
  return fetchAnthropicJson('/api/oauth/usage', token);
}

async function fetchAnthropicJson(path: string, token: string): Promise<{ status: number; data: any | null; retryAfter?: string | null }> {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
  };
  try {
    const res = await fetch(`https://api.anthropic.com${path}`, { headers });
    if (!res.ok) return { status: res.status, data: null, retryAfter: res.headers.get('retry-after') };
    return { status: res.status, data: await res.json(), retryAfter: res.headers.get('retry-after') };
  } catch {
    return fetchAnthropicJsonWithCurl(path, headers);
  }
}

function fetchAnthropicJsonWithCurl(path: string, headers: Record<string, string>): { status: number; data: any | null; retryAfter?: string | null } {
  try {
    const config = [
      'silent',
      'show-error',
      `url = ${JSON.stringify(`https://api.anthropic.com${path}`)}`,
      'dump-header = -',
      ...Object.entries(headers).map(([k, v]) => `header = ${JSON.stringify(`${k}: ${v}`)}`),
    ].join('\n');
    const out = execFileSync('curl', ['--config', '-', '--write-out', '\nASX_HTTP_STATUS:%{http_code}'], {
      input: config,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 15_000,
    });
    const m = out.match(/\nASX_HTTP_STATUS:(\d{3})\s*$/);
    if (!m) return { status: 0, data: null };
    const raw = out.slice(0, m.index);
    const split = raw.match(/\r?\n\r?\n/);
    const headerText = split ? raw.slice(0, split.index) : '';
    const body = (split ? raw.slice((split.index || 0) + split[0].length) : raw).trim();
    const retryAfter = headerText.match(/^retry-after:\s*(.+)$/im)?.[1]?.trim() || null;
    const status = Number(m[1]);
    return { status, data: status >= 200 && status < 300 && body ? JSON.parse(body) : null, retryAfter };
  } catch {
    return { status: 0, data: null };
  }
}

export const claudeCodeAdapter: ProviderAdapter = {
  name: PROVIDER,

  async loadCurrent(accountName: string, label?: string) {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      await this.loadLongLivedToken?.(accountName, process.env.CLAUDE_CODE_OAUTH_TOKEN);
      return;
    }
    const current = readCurrentCredentials();
    if (!current) {
      throw new Error('No active Claude Code credentials found. Login with `claude` (or `claude auth login`) first, then run `asx load claude <name>`.');
    }
    const email = await extractClaudeEmail(current);
    await setSecret(PROVIDER, accountName, current);

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
    if (!isClaudeCodeLongLivedToken(stored)) writeActiveCredentials(stored);
    // update lightweight active marker
    const { setActive } = await import('../storage/account-store.js');
    setActive(PROVIDER, accountName);
  },

  async getCurrentCredential() {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return makeLongLivedTokenCredential(process.env.CLAUDE_CODE_OAUTH_TOKEN);
    }
    return readCurrentCredentials();
  },

  async getCurrentEmail() {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return extractClaudeEmail(makeLongLivedTokenCredential(process.env.CLAUDE_CODE_OAUTH_TOKEN));
    }
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

  async isExpired(accountName?: string) {
    const raw = await getSecret(PROVIDER, accountName || '');
    if (!raw) return false;
    if (isClaudeCodeLongLivedToken(raw)) return false;
    try {
      const o = JSON.parse(raw).claudeAiOauth || {};
      return typeof o.expiresAt === 'number' && o.expiresAt < Date.now() + 60_000;
    } catch { return false; }
  },

  async refresh(accountName?: string) {
    const raw = await getSecret(PROVIDER, accountName || '');
    if (!raw) return { ok: false, message: 'no stored credential' };
    if (isClaudeCodeLongLivedToken(raw)) return { ok: true, message: 'long-lived token does not need refresh' };
    let o: any;
    try { o = JSON.parse(raw).claudeAiOauth; } catch { return { ok: false, message: 'stored credential is not valid JSON' }; }
    if (!o?.refreshToken) return { ok: false, message: 'no refresh token stored', needsRelogin: true };
    let res: Response;
    try {
      res = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID }),
      });
    } catch (e: any) { return { ok: false, message: `network error: ${e?.message || e}` }; }
    if (!res.ok) {
      const j: any = await res.json().catch(() => ({}));
      if (j.error === 'invalid_grant') return { ok: false, message: 'refresh token invalid/revoked', needsRelogin: true };
      return { ok: false, message: `refresh failed (HTTP ${res.status}: ${j.error || ''})` };
    }
    const j: any = await res.json();
    const updated = { claudeAiOauth: { ...o, accessToken: j.access_token, refreshToken: j.refresh_token || o.refreshToken, expiresAt: Date.now() + (j.expires_in || 0) * 1000 } };
    const newRaw = JSON.stringify(updated);
    await setSecret(PROVIDER, accountName || '', newRaw);
    // If this account is the one currently live in the system, push the refreshed token to
    // the native store too (keychain / ~/.claude) so the native `claude` binary and any
    // non-isolated exec use the fresh token instead of the stale one.
    let syncedNative = false;
    try {
      if (readCurrentCredentials() === raw) { writeActiveCredentials(newRaw); syncedNative = true; }
    } catch {}
    return { ok: true, message: `refreshed (expires ${new Date(updated.claudeAiOauth.expiresAt).toISOString()})${syncedNative ? ' [native synced]' : ''}` };
  },

  async getUsage(accountName?: string) {
    try {
      const raw = await getSecret(PROVIDER, accountName || '');
      if (!raw) return 'No stored credential for this account.';

      const data = JSON.parse(raw);
      const isLongLived = data?.type === LONG_LIVED_TOKEN_TYPE;
      const oauth = data?.claudeAiOauth || {};
      const tier = oauth.rateLimitTier || 'unknown';
      const subType = oauth.subscriptionType || 'unknown';

      const namePart = accountName ? ` (${accountName})` : '';

      const token = getClaudeCodeOAuthToken(raw);
      let baseInfo = isLongLived ? `long-lived token${namePart}` : `subscription=${subType} tier=${tier}${namePart}`;

      if (token) {
        try {
          const { status, data: prof } = await fetchAnthropicJson('/api/oauth/profile', token);
          if (status >= 200 && status < 300 && prof) {
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
      if (!token) return baseInfo + '\n  ⚠ Unable to fetch usage — no access token stored.';

      // Live usage is the source of truth. A 401/403 means the token is expired/invalid;
      // do NOT fall back to stale local history (it would report misleading usage).
      const { status, data: usage, retryAfter } = await fetchOAuthUsage(token);
      if (status === 401 || status === 403) {
        return baseInfo + `\n  ⚠ Unable to fetch usage — token expired or invalid (HTTP ${status}). Re-login: asx login claude`;
      }
      if (status === 429) {
        return baseInfo + `\n  ⚠ Unable to fetch usage — rate limited (HTTP 429)${retryAfter ? `, retry after ${retryAfter}s` : ''}.`;
      }
      if (!usage) {
        const why = status === 0 ? 'network error' : `HTTP ${status}`;
        return baseInfo + `\n  ⚠ Unable to fetch usage (${why}).`;
      }

      let extra = '';
      const f = usage.five_hour || usage.fiveHour;
      const s = usage.seven_day || usage.sevenDay;
      if (f && typeof f.utilization === 'number') {
        const used5 = Math.max(0, Math.min(100, f.utilization));
        const rem5 = Math.max(0, 100 - used5);
        const r = f.resets_at ? formatReset(f.resets_at) : '';
        extra += `\n  5h: ${renderBar(rem5)} ${rem5.toFixed(1)}% / ${used5.toFixed(1)}%${r ? ` — ${r}` : ''}`;
      }
      if (s && typeof s.utilization === 'number') {
        const used7 = Math.max(0, Math.min(100, s.utilization));
        const rem7 = Math.max(0, 100 - used7);
        const r = s.resets_at ? formatReset(s.resets_at) : '';
        extra += `\n  7d: ${renderBar(rem7)} ${rem7.toFixed(1)}% / ${used7.toFixed(1)}%${r ? ` — ${r}` : ''}`;
      }
      if (!extra) extra = '\n  ⚠ Unable to fetch usage — no quota data returned.';

      return baseInfo + extra;
    } catch (e) {
      return 'Unable to read usage info from stored credential.';
    }
  },

  async loadLongLivedToken(accountName: string, token: string) {
    const raw = makeLongLivedTokenCredential(token);
    const email = await extractClaudeEmail(raw);
    await setSecret(PROVIDER, accountName, raw);
    addAccount({ provider: PROVIDER, name: accountName, label: accountName, email });
  },
};
