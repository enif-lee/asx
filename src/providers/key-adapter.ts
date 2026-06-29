import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSecret, getSecret } from '../storage/secure-store.js';
import { addAccount } from '../storage/account-store.js';
import { renderBar } from '../utils/bar.js';
import type { ProviderAdapter } from './base.js';

function tryExtractGrokEmail(): string | undefined {
  try {
    const grokPath = path.join(os.homedir(), '.grok', 'auth.json');
    if (fs.existsSync(grokPath)) {
      const data = JSON.parse(fs.readFileSync(grokPath, 'utf8'));
      // Structure from earlier inspection: top level has email
      const entry = Object.values(data)[0] as any;
      return entry?.email;
    }
  } catch {}
  return undefined;
}

export function createKeyAdapter(provider: string): ProviderAdapter {
  return {
    name: provider,
    async addAccount(accountName: string, label?: string) {
      // Prefer real key from env so it gets stored in the single vault (matching openusage credential handling).
      let val = process.env[`${provider.toUpperCase()}_KEY`] || process.env.XAI_API_KEY;
      if (!val) val = 'demo-key-' + accountName; // demo only
      let email: string | undefined;
      if (provider === 'grok' || provider === 'xai') {
        email = tryExtractGrokEmail();
      }
      await setSecret(provider, accountName, val, { email, label: label || accountName });

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
      if (!key && (provider === 'grok' || provider === 'xai')) {
        key = process.env.XAI_API_KEY || process.env['XAI_API_KEY'] || null;
      }
      if (!key) return `API key (no live quota data)${suffix}`;

      const isGrok = provider === 'grok' || provider === 'xai';
      const base = 'https://api.x.ai/v1';
      const headers = { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' };

      try {
        if (isGrok) {
          // Grok (xAI) specific: use /api-key for credits (like openusage)
          const keyRes = await fetch(`${base}/api-key`, { headers });
          let lines: string[] = [];
          if (keyRes.ok) {
            const kinfo: any = await keyRes.json();
            const rem = kinfo.remaining_balance;
            const spent = kinfo.spent_balance;
            const total = kinfo.total_granted;
            if (rem != null && total != null && total > 0) {
              const used = Math.max(0, total - rem);
              const usedPct = Math.min(100, (used / total) * 100);
              const remPct = Math.max(0, 100 - usedPct);
              lines.push(`credits: ${renderBar(remPct)} ${remPct.toFixed(1)}% / ${usedPct.toFixed(1)}% ($${rem.toFixed(2)} left)`);
            } else if (rem != null) {
              lines.push(`credits_remaining=$${rem}`);
            }
            if (kinfo.name) lines.push(`key=${kinfo.name}`);
          }

          // rate limits via headers on /models
          const modelsRes = await fetch(`${base}/models`, { headers });
          if (modelsRes.ok) {
            const remReq = modelsRes.headers.get('x-ratelimit-remaining-requests');
            const remTok = modelsRes.headers.get('x-ratelimit-remaining-tokens');
            if (remReq || remTok) {
              lines.push(`rate remaining req=${remReq ?? '?'} tok=${remTok ?? '?'}`);
            }
          }

          if (lines.length === 0) return `API key info fetched${suffix}`;
          return `${lines[0]}${suffix}\n  ${lines.slice(1).join('\n  ')}`;
        }

        // generic key provider (e.g. zai) - minimal info
        return `API key stored${suffix}`;
      } catch (e: any) {
        return `API key fetch error: ${e.message || e}${suffix}`;
      }
    },

    async getCurrentEmail() {
      if (provider === 'grok' || provider === 'xai') {
        return tryExtractGrokEmail();
      }
      return undefined;
    },
  };
}
