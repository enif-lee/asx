import fs from 'node:fs';
import { setSecret, getSecret } from '../storage/secure-store.js';
import { addAccount, setActive, getAccount } from '../storage/account-store.js';
import { renderBar } from '../utils/bar.js';
import { decodeJwtClaims } from '../utils/jwt.js';
import { ensureDirFor, getGrokAuthPath, getGrokVersion } from '../utils/platform.js';
import type { ProviderAdapter } from './base.js';

const ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

function getEnvKey(provider: string): string | undefined {
  const prefix = provider.toUpperCase();
  return process.env[`${prefix}_API_KEY`]
    || process.env[`${prefix}_KEY`]
    || (provider === 'grok' ? process.env.XAI_API_KEY : undefined);
}

function getGrokAuthFile(): any | undefined {
  try {
    const grokPath = getGrokAuthPath();
    if (fs.existsSync(grokPath)) {
      return JSON.parse(fs.readFileSync(grokPath, 'utf8'));
    }
  } catch {}
  return undefined;
}

function getGrokAuth(): any | undefined {
  const data = getGrokAuthFile();
  if (!data || typeof data !== 'object') return undefined;
  if (data.key) return data;
  return Object.values(data)[0] as any;
}

function parseJson(raw: string): any | undefined {
  try { return JSON.parse(raw); } catch { return undefined; }
}

function grokAuthFileFromCredential(raw: string): any {
  const data = parseJson(raw);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (data.key) return { asx: data };
    return data;
  }
  return { asx: { key: raw } };
}

function grokBearer(raw: string): string {
  const data = parseJson(raw);
  if (data && typeof data === 'object') {
    if (typeof data.key === 'string') return data.key;
    const entry = Object.values(data).find((v: any) => v && typeof v === 'object' && typeof v.key === 'string') as any;
    if (entry?.key) return entry.key;
  }
  return raw;
}

function writeGrokAuth(raw: string): void {
  const p = getGrokAuthPath();
  ensureDirFor(p);
  fs.writeFileSync(p, JSON.stringify(grokAuthFileFromCredential(raw)), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
}

function tryExtractGrokEmail(): string | undefined {
  const auth = getGrokAuth();
  return auth?.email;
}

function parseGrokTokenInfo(token: string): any {
  if (!token || !token.startsWith('ey')) return null;
  return decodeJwtClaims(token);
}

// Extract the grok OIDC auth entry (object with key/refresh_token/oidc_*) from a
// stored secret string. Supports both the bare-key form ("ey..." / "{\"key\":...}")
// and the grok auth.json wrapper ({ "<issuer>::<uuid>": { ... } }).
function grokEntryFromRaw(raw: string): any | undefined {
  const data = parseJson(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    // Bare JWT / plain string — no refresh_token available.
    return undefined;
  }
  if (data.key && typeof data.key === 'string') return data;
  const entry = Object.values(data).find((v: any) => v && typeof v === 'object' && typeof v.key === 'string') as any;
  return entry;
}

// grok CLI refresh grant: POST https://<issuer>/oauth2/token with grant_type=refresh_token.
// Verified wire (grok 0.2.82): form-encoded body, returns { access_token, refresh_token,
// token_type, expires_in, scope }. Requires the grok-cli client headers or Cloudflare rejects.
// Returns { token, refreshToken, expiresIn } on success, or null on failure.
async function grokRefreshGrant(entry: any): Promise<{ token: string; refreshToken: string; expiresIn: number } | null> {
  const refreshToken = entry?.refresh_token;
  if (typeof refreshToken !== 'string' || !refreshToken) return null;
  const issuer = entry.oidc_issuer || 'https://auth.x.ai';
  const clientId = entry.oidc_client_id;
  if (!clientId) return null;
  const version = getGrokVersion();
  let res: Response;
  try {
    res = await fetch(`${issuer}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-grok-client-version': version,
        'x-grok-client-surface': 'grok-build',
        'x-grok-client-identifier': 'grok-shell',
        'User-Agent': `grok-shell/${version} (macos; aarch64)`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
  } catch {
    return null; // network error — transient
  }
  if (!res.ok) return null;
  const j: any = await res.json().catch(() => null);
  if (!j || typeof j.access_token !== 'string') return null;
  return {
    token: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : refreshToken,
    expiresIn: typeof j.expires_in === 'number' ? j.expires_in : 21600,
  };
}

function parsePercent(value: any): number | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return null;
  return n <= 1 && !String(value).trim().endsWith('%') ? n * 100 : n;
}

async function testZaiKey(key: string): Promise<void> {
  const res = await fetch(`${ZAI_BASE_URL}/models`, {
    headers: {
      Authorization: `Bearer ${key}`,
    },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 240);
    throw new Error(`ZAI endpoint test failed (${res.status} ${res.statusText}${detail ? `: ${detail}` : ''})`);
  }
}

export function createKeyAdapter(provider: string): ProviderAdapter {
  return {
    name: provider,
    async loadCurrent(accountName: string, label?: string) {
      // Prefer real key from env so it gets stored in the single vault (matching openusage credential handling).
      let val = getEnvKey(provider);
      if (!val && provider === 'grok') {
        // For Grok consumer/CLI accounts, read the token from ~/.grok/auth.json
        // (openusage appears to use this for subscription quota without XAI_API_KEY env)
        const auth = getGrokAuthFile();
        if (auth) {
          // Store the full auth file so the native CLI issuer key is preserved.
          val = JSON.stringify(auth);
        }
      }
      if (!val) val = 'demo-key-' + accountName; // demo only
      let email: string | undefined;
      if (provider === 'grok') {
        email = tryExtractGrokEmail();
      }
      await setSecret(provider, accountName, val);

      addAccount({ provider, name: accountName, label: label || accountName, email });
    },
    async login(accountName: string, label?: string) {
      if (provider !== 'zai') throw new Error(`Login flow is not supported for provider '${provider}'.`);
      const envKey = process.env.ASX_ZAI_API_KEY;
      const key = (envKey || await (async () => {
        const { password } = await import('@inquirer/prompts');
        return password({ message: 'Paste Z.AI API key:' });
      })()).trim();
      if (!key) throw new Error('No Z.AI API key provided.');

      await testZaiKey(key);
      await setSecret(provider, accountName, key);
      addAccount({ provider, name: accountName, label: label || accountName });
      setActive(provider, accountName);
    },
    async switchTo(accountName: string) {
      const v = await getSecret(provider, accountName);
      if (!v) throw new Error(`No key for ${provider}/${accountName}`);
      if (provider === 'grok') {
        writeGrokAuth(v);
        process.env.XAI_API_KEY = grokBearer(v);
      } else {
        // For pure key providers we just set in process or print export advice
        process.env[`${provider.toUpperCase()}_API_KEY`] = v;
      }
      console.log(`[as] ${provider} key for ${accountName} is now active in this process.`);
      setActive(provider, accountName);
    },
    async getUsage(accountName?: string) {
      const suffix = accountName ? ` (${accountName})` : '';
      let key: string | null = await getSecret(provider, accountName || '');
      if (!key && provider === 'grok') {
        key = process.env.XAI_API_KEY || process.env['XAI_API_KEY'] || null;
        if (!key) {
          // Fallback for Grok accounts loaded from ~/.grok/auth.json (no XAI env)
          const auth = getGrokAuth();
          key = auth?.key || null;
        }
      }
      if (!key) return `API key (no live quota data)${suffix}`;
      if (provider === 'grok') key = grokBearer(key);

      const isGrok = provider === 'grok';
      const base = 'https://api.x.ai/v1';
      // match openusage style: just Bearer auth (no extra Accept)
      const authHeaders = { Authorization: `Bearer ${key}` };

      try {
        if (isGrok) {
          let lines: string[] = [];
          let keyName = '';

          const isGrokJwt = key && key.startsWith('ey');

          if (isGrokJwt) {
            // For Grok CLI / subscription accounts (token from ~/.grok/auth.json)
            // Use the CLI billing endpoint for subscription quota (like usagebar, codexbar etc.)
            try {
              const billingRes = await fetch('https://cli-chat-proxy.grok.com/v1/billing', { headers: authHeaders });
              if (billingRes.ok) {
                const binfo: any = await billingRes.json();
                const config = binfo.config || {};
                const monthlyLimit = config.monthlyLimit?.val ?? config.monthly_limit?.val;
                const used = config.used?.val ?? config.used?.val;
                if (monthlyLimit != null && used != null) {
                  const rem = Math.max(0, monthlyLimit - used);
                  const usedPct = Math.min(100, (used / monthlyLimit) * 100);
                  const remPct = Math.max(0, 100 - usedPct);
                  lines.push(`credits: ${renderBar(remPct)} ${remPct.toFixed(1)}% / ${usedPct.toFixed(1)}% (${used}/${monthlyLimit})`);
                }
                if (binfo.billingPeriodEnd) {
                  lines.push(`billingPeriodEnd=${binfo.billingPeriodEnd}`);
                }
              }
            } catch {}

            // Also try settings for plan info
            try {
              const settingsRes = await fetch('https://cli-chat-proxy.grok.com/v1/settings', { headers: authHeaders });
              if (settingsRes.ok) {
                const sinfo: any = await settingsRes.json();
                if (sinfo.plan || sinfo.subscription) {
                  keyName = sinfo.plan || sinfo.subscription;
                }
              }
            } catch {}
          } else {
            // credits from /api-key for pure XAI API keys
            try {
              const keyRes = await fetch(`${base}/api-key`, { headers: authHeaders });
              if (keyRes.ok) {
                const kinfo: any = await keyRes.json();
                const rem = kinfo.remaining_balance ?? kinfo.remainingBalance;
                const spent = kinfo.spent_balance ?? kinfo.spentBalance;
                const total = kinfo.total_granted ?? kinfo.totalGranted;
                if (rem != null && total != null && total > 0) {
                  const used = Math.max(0, total - rem);
                  const usedPct = Math.min(100, (used / total) * 100);
                  const remPct = Math.max(0, 100 - usedPct);
                  lines.push(`credits: ${renderBar(remPct)} ${remPct.toFixed(1)}% / ${usedPct.toFixed(1)}% ($${rem.toFixed(2)} left)`);
                } else if (rem != null) {
                  lines.push(`credits_remaining=$${rem}`);
                }
                if (kinfo.name) {
                  keyName = kinfo.name;
                  lines.push(`key=${kinfo.name}`);
                }
              }
            } catch {}
          }

          // rate limits ...
          let rateLines: string[] = [];
          try {
            const modelsRes = await fetch(`${base}/models`, { headers: authHeaders });
            if (modelsRes.ok) {
              const remReq = modelsRes.headers.get('x-ratelimit-remaining-requests');
              const remTok = modelsRes.headers.get('x-ratelimit-remaining-tokens');
              if (remReq || remTok) {
                rateLines.push(`rate remaining req=${remReq ?? '?'} tok=${remTok ?? '?'}`);
              }
            }
          } catch {}
          if (rateLines.length === 0 && isGrok) {
            try {
              const probeRes = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model: 'grok-4.20-non-reasoning',
                  messages: [{ role: 'user', content: 'hi' }],
                  max_tokens: 1
                })
              });
              const remReq = probeRes.headers.get('x-ratelimit-remaining-requests');
              const remTok = probeRes.headers.get('x-ratelimit-remaining-tokens');
              if (remReq || remTok) {
                rateLines.push(`rate remaining req=${remReq ?? '?'} tok=${remTok ?? '?'}`);
              }
            } catch {}
          }
          lines.push(...rateLines);

          const prefix = keyName ? `Grok ${keyName}` : 'Grok key';
          const tokenInfo = parseGrokTokenInfo(key);
          let tierInfo = '';
          if (tokenInfo) {
            const tier = tokenInfo.tier ?? '?';
            const team = tokenInfo.team_id ? ` team=${tokenInfo.team_id}` : '';
            tierInfo = ` tier=${tier}${team}`;
          }
          if (lines.length === 0) {
            return `${prefix}${tierInfo} (rate limits via headers on calls)${suffix}`;
          }
          if (tierInfo) {
            lines[0] = lines[0] + tierInfo;
          }
          return `${lines[0]}${suffix}\n  ${lines.slice(1).join('\n  ')}`;
        }

        if (provider === 'zai') {
          const res = await fetch(ZAI_QUOTA_URL, {
            headers: {
              Authorization: key,
              'Accept-Language': 'en-US,en',
              'Content-Type': 'application/json',
            },
          });
          if (!res.ok) return `ZAI usage fetch failed: ${res.status}${suffix}`;

          const payload: any = await res.json();
          const limits = payload?.data?.limits || payload?.limits || [];
          const tokenLimit = Array.isArray(limits) ? limits.find((x: any) => x?.type === 'TOKENS_LIMIT') : null;
          const usedPct = parsePercent(tokenLimit?.percentage);
          if (usedPct == null) return `ZAI usage (no token quota returned)${suffix}`;

          const used = Math.max(0, Math.min(100, usedPct));
          const rem = Math.max(0, 100 - used);
          return `5h: ${renderBar(rem)} ${rem.toFixed(1)}% / ${used.toFixed(1)}%${suffix}`;
        }

        // generic key provider - minimal info
        return `API key stored${suffix}`;
      } catch (e: any) {
        return `API key fetch error: ${e.message || e}${suffix}`;
      }
    },

    async getCurrentEmail() {
      if (provider === 'grok') {
        return tryExtractGrokEmail();
      }
      return undefined;
    },

    async getCurrentCredential() {
      if (provider === 'grok') {
        const auth = getGrokAuthFile();
        return auth ? JSON.stringify(auth) : null;
      }
      // For other key providers (e.g. zai), prefer the env if present
      return getEnvKey(provider) || null;
    },

    async clearCurrent() {
      if (provider === 'grok') {
        try { fs.rmSync(getGrokAuthPath(), { force: true }); } catch {}
      }
      // Other API-key providers have no local persistent session to clear.
    },

    getLoginCommand() {
      if (provider === 'grok') return ['grok', 'login'];
      return null;
    },

    // grok OIDC accounts store a JWT (key) + refresh_token. Detect expiry from the
    // JWT exp claim (60s skew), like the codex/claude adapters. Pure API keys
    // (no refresh path) are treated as never-expiring.
    async isExpired(accountName?: string) {
      if (provider !== 'grok') return false;
      const raw = await getSecret(provider, accountName || '');
      if (!raw) return false;
      const entry = grokEntryFromRaw(raw);
      if (entry?.refresh_token) {
        const claims = decodeJwtClaims(entry.key);
        return !!claims && typeof claims.exp === 'number' && claims.exp * 1000 < Date.now() + 60_000;
      }
      return false; // bare API key — no expiry
    },

    // Refresh a grok OIDC account using its stored refresh_token. Mirrors the
    // claude-code adapter direct OAuth grant (no native binary needed). On
    // success, the rotated access_token/refresh_token/expires_at are written back
    // to the asx vault (preserving the original issuer-keyed wrapper), and pushed
    // to the native ~/.grok/auth.json if it holds this account's old credential.
    async refresh(accountName?: string) {
      if (provider !== 'grok') return { ok: true, message: 'no refresh needed (api key)' };
      const name = accountName || '';
      const raw = await getSecret(provider, name);
      if (!raw) return { ok: false, message: 'no stored credential' };
      const data = parseJson(raw);
      const entry = grokEntryFromRaw(raw);
      if (!entry?.refresh_token) return { ok: false, message: 'no refresh token stored', needsRelogin: true };

      const refreshed = await grokRefreshGrant(entry);
      if (!refreshed) {
        // Could be transient (network) or permanent (revoked refresh token). We can't
        // always tell, so surface a hint to re-login if it keeps failing.
        return { ok: false, message: 'refresh failed (network or revoked refresh token)', needsRelogin: true };
      }

      // Build the updated entry, then re-wrap using the same structure as the stored secret.
      const updatedEntry: any = { ...entry, key: refreshed.token, refresh_token: refreshed.refreshToken };
      // Update expires_at (ISO 8601, UTC with Z) so isExpired/expires checks stay consistent.
      updatedEntry.expires_at = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();

      let newRaw: string;
      if (data && typeof data === 'object' && !Array.isArray(data) && !data.key) {
        // Issuer-keyed wrapper { "<issuer>::<uuid>": entry } — replace the matching entry in place.
        const wrapperKey = Object.keys(data).find((k) => data[k] === entry) || Object.keys(data)[0];
        newRaw = JSON.stringify({ ...data, [wrapperKey]: updatedEntry });
      } else {
        // { key, ... } flat form.
        newRaw = JSON.stringify(updatedEntry);
      }
      await setSecret(provider, name, newRaw);

      // System profiles use the shared ~/.grok/auth.json as their home (the native grok
      // binary reads it directly), so a refresh must write back there too. Isolated
      // profiles own a separate profile home and must not touch the system file.
      let syncedNative = false;
      try {
        const acc = getAccount(provider, name);
        const isSystem = acc?.profileType === 'system';
        if (isSystem) {
          writeGrokAuth(newRaw);
          syncedNative = true;
        }
      } catch {}

      return { ok: true, message: `refreshed (expires ${updatedEntry.expires_at})${syncedNative ? ' [native synced]' : ''}` };
    },
  };
}
