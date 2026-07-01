import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSecret, getSecret } from '../storage/secure-store.js';
import { addAccount } from '../storage/account-store.js';
import { renderBar } from '../utils/bar.js';
import { decodeJwtClaims } from '../utils/jwt.js';
import type { ProviderAdapter } from './base.js';

function getGrokAuth(): any | undefined {
  try {
    const grokPath = path.join(os.homedir(), '.grok', 'auth.json');
    if (fs.existsSync(grokPath)) {
      const data = JSON.parse(fs.readFileSync(grokPath, 'utf8'));
      const entry = Object.values(data)[0] as any;
      return entry;
    }
  } catch {}
  return undefined;
}

function tryExtractGrokEmail(): string | undefined {
  const auth = getGrokAuth();
  return auth?.email;
}

function parseGrokTokenInfo(token: string): any {
  if (!token || !token.startsWith('ey')) return null;
  return decodeJwtClaims(token);
}

export function createKeyAdapter(provider: string): ProviderAdapter {
  return {
    name: provider,
    async loadCurrent(accountName: string, label?: string) {
      // Prefer real key from env so it gets stored in the single vault (matching openusage credential handling).
      let val = process.env[`${provider.toUpperCase()}_KEY`] || process.env.XAI_API_KEY;
      if (!val && provider === 'grok') {
        // For Grok consumer/CLI accounts, read the token from ~/.grok/auth.json
        // (openusage appears to use this for subscription quota without XAI_API_KEY env)
        const auth = getGrokAuth();
        if (auth) {
          // Store full auth entry so refresh_token etc. are preserved if present
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
    async switchTo(accountName: string) {
      const v = await getSecret(provider, accountName);
      if (!v) throw new Error(`No key for ${provider}/${accountName}`);
      // For pure key providers we just set in process or print export advice
      process.env[`${provider.toUpperCase()}_API_KEY`] = v;
      console.log(`[as] ${provider} key for ${accountName} is now active in this process.`);
      const { setActive } = await import('../storage/account-store.js');
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

        // generic key provider (e.g. zai) - minimal info
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
        const auth = getGrokAuth();
        return auth ? JSON.stringify(auth) : null;
      }
      // For other key providers (e.g. zai), prefer the env if present
      const envKey = process.env[`${provider.toUpperCase()}_KEY`] || process.env.XAI_API_KEY || process.env.ZAI_API_KEY;
      return envKey || null;
    },

    async clearCurrent() {
      // API-key providers have no local persistent session to clear.
    },

    getLoginCommand() {
      return null;
    },
  };
}
