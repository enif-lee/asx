import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { setSecret, getSecret } from '../storage/secure-store.js';
import { addAccount } from '../storage/account-store.js';
import { getCodexAuthPath, ensureDirFor } from '../utils/platform.js';
import { renderBar } from '../utils/bar.js';
import type { ProviderAdapter } from './base.js';

function extractCodexEmail(authJson: string): string | undefined {
  try {
    const data = JSON.parse(authJson);
    // Try top level
    if (data.email) return data.email;

    const idToken = data?.tokens?.id_token;
    if (idToken && typeof idToken === 'string') {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = parts[1];
        // base64url decode
        const b64 = payload.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - payload.length % 4) % 4);
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const claims = JSON.parse(decoded);
        return claims.email || claims.email_address;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const P = 'codex';

function readCodexAuth(): string | null {
  const p = getCodexAuthPath();
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function writeCodexAuth(raw: string) {
  const p = getCodexAuthPath();
  ensureDirFor(p);
  fs.writeFileSync(p, raw);
  try { fs.chmodSync(p, 0o600); } catch {}
}

function extractPlanFromIdToken(idToken: string) {
  try {
    const payload = idToken.split('.')[1];
    const json = Buffer.from(payload, 'base64').toString();
    const claims = JSON.parse(json);
    const auth = claims['https://api.openai.com/auth'] || {};
    return {
      planType: auth.chatgpt_plan_type,
      activeUntil: auth.chatgpt_subscription_active_until,
    };
  } catch {
    return null;
  }
}

async function attemptCodexNativeRefresh(accountName: string): Promise<boolean> {
  try {
    const stored = await getSecret(P, accountName);
    if (!stored) return false;

    // Inject the snapshot (possibly with expired access token) into native storage.
    // The native `codex` CLI will then load it and run its own refresh logic using the refresh_token.
    writeCodexAuth(stored);

    // Run a native command that exercises auth loading + health checks.
    // `codex doctor` (with --summary for brevity) explicitly validates auth.credentials and will
    // cause Codex to perform its internal refresh using the refresh_token if the access token
    // is expired or near expiry, then it writes the fresh tokens back to ~/.codex/auth.json.
    try {
      execSync('codex doctor --summary', {
        stdio: 'ignore',
        timeout: 20000,
      });
    } catch {
      // Non-fatal. Even if doctor reports issues, refresh may have occurred.
      // As a fallback also try the lighter status command.
      try {
        execSync('codex login status', { stdio: 'ignore', timeout: 8000 });
      } catch {}
    }

    // Re-snapshot whatever is now in the native file (should contain refreshed tokens).
    const fresh = readCodexAuth();
    if (!fresh) return false;

    const email = extractCodexEmail(fresh);
    await setSecret(P, accountName, fresh, { email, label: accountName });
    addAccount({ provider: P, name: accountName, label: accountName, email });

    return true;
  } catch {
    return false;
  }
}

async function fetchAndFormatCodexUsage(
  token: string,
  accountId: string | undefined,
  originalDataForPlan: any,
  accountName?: string,
): Promise<string> {
  const base = 'https://chatgpt.com/backend-api';
  const url = `${base}/wham/usage`;
  const headers: any = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'User-Agent': 'codex-cli',
  };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    return `live usage fetch failed: ${res.status}`;
  }
  const payload: any = await res.json();

  const rl = payload?.rate_limit || payload?.rate_limits || {};
  const primary = rl.primary_window || rl.primary;
  const secondary = rl.secondary_window || rl.secondary;
  const planType = payload?.plan_type || rl.plan_type || (originalDataForPlan?.tokens?.id_token ? extractPlanFromIdToken(originalDataForPlan.tokens.id_token)?.planType : null);

  const parts: string[] = [];
  if (planType) parts.push(`plan=${planType}`);
  const suffix = accountName ? ` for ${accountName}` : '';

  let output = parts.length ? parts.join(' ') + suffix : `subscription-based (5h reasoning windows)${suffix}`;

  if (primary && typeof primary.used_percent === 'number') {
    const used5 = primary.used_percent;
    const rem5 = Math.max(0, 100 - used5);
    const bar5 = renderBar(rem5);
    const reset = primary.reset_at ? new Date(primary.reset_at * 1000).toISOString().slice(11,16)+'Z' : (primary.reset_after_seconds ? primary.reset_after_seconds+'s' : '');
    output += `\n  5h: ${bar5} ${rem5.toFixed(1)}% / ${used5.toFixed(1)}%${reset ? ' (resets ~' + reset + ')' : ''}`;
  }
  if (secondary && typeof secondary.used_percent === 'number') {
    const used7 = secondary.used_percent;
    const rem7 = Math.max(0, 100 - used7);
    const bar7 = renderBar(rem7);
    output += `\n  7d: ${bar7} ${rem7.toFixed(1)}% / ${used7.toFixed(1)}%`;
  }

  return output;
}

export const codexAdapter: ProviderAdapter = {
  name: P,
  async loadCurrent(name: string, label?: string) {
    const cur = readCodexAuth();
    if (!cur) throw new Error('No ~/.codex/auth.json found. Login with `codex` first.');
    const email = extractCodexEmail(cur);
    await setSecret(P, name, cur, { email, label: label || name });

    addAccount({ provider: P, name, label: label || name, email });
  },
  async switchTo(name: string) {
    const s = await getSecret(P, name);
    if (!s) throw new Error('Account not found');
    writeCodexAuth(s);
    const { setActive } = await import('../storage/account-store.js');
    setActive(P, name);
  },
  async getUsage(accountName?: string) {
    const name = accountName || '';
    try {
      let raw = await getSecret(P, name);
      if (!raw) return 'No stored credential for this account.';

      let data = JSON.parse(raw);
      let token = data?.tokens?.access_token;
      if (!token) {
        const plan = data?.tokens?.id_token ? extractPlanFromIdToken(data.tokens.id_token) : null;
        const suffix = accountName ? ` for ${accountName}` : '';
        if (plan) return `plan=${plan.planType || 'unknown'} active_until=${plan.activeUntil || 'unknown'}`;
        return `subscription-based (5h reasoning windows)${suffix}`;
      }

      const accountId = data?.tokens?.account_id || data?.account_id;

      // First attempt with current stored token
      let output = await fetchAndFormatCodexUsage(token, accountId, data, accountName);

      // If it failed with an auth-related error, attempt indirect native refresh:
      //  - write the snapshot to native location
      //  - let `codex login status` (or equivalent) run Codex's own refresh using its refresh_token
      //  - re-load the (now refreshed) credential back into the asx vault
      //  - retry the usage fetch once
      const looksLikeAuthFail = /live usage fetch failed: (401|403)/.test(output) ||
        /auth|token|expired|unauthorized|invalid/i.test(output);

      if (looksLikeAuthFail) {
        const didRefresh = await attemptCodexNativeRefresh(name);
        if (didRefresh) {
          raw = await getSecret(P, name);
          if (raw) {
            data = JSON.parse(raw);
            token = data?.tokens?.access_token;
            const newAccountId = data?.tokens?.account_id || data?.account_id;
            if (token) {
              const retryOutput = await fetchAndFormatCodexUsage(token, newAccountId, data, accountName);
              output = retryOutput;
            }
          }
        }
      }

      return output;
    } catch (e: any) {
      // On unexpected error, still try one auto-refresh + retry
      try {
        const did = await attemptCodexNativeRefresh(name);
        if (did) {
          const raw2 = await getSecret(P, name);
          if (raw2) {
            const d2 = JSON.parse(raw2);
            const t2 = d2?.tokens?.access_token;
            const aid2 = d2?.tokens?.account_id || d2?.account_id;
            if (t2) {
              return await fetchAndFormatCodexUsage(t2, aid2, d2, accountName);
            }
          }
        }
      } catch {}
      return `Unable to fetch live usage: ${e.message || e}`;
    }
  },
  async getCurrentEmail() {
    const cur = readCodexAuth();
    return cur ? extractCodexEmail(cur) : undefined;
  },

  async getCurrentCredential() {
    return readCodexAuth();
  },

  async clearCurrent() {
    const p = getCodexAuthPath();
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  },

  getLoginCommand() {
    return ['codex'];
  },
};
