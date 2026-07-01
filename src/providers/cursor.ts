import chalk from 'chalk';
import { addAccount } from '../storage/account-store.js';
import { getSecret, setSecret } from '../storage/secure-store.js';
import type { ProviderAdapter } from './base.js';

const P = 'cursor';

export const cursorAdapter: ProviderAdapter = {
  name: P,

  async loadCurrent(name: string, label?: string) {
    // For Cursor, full credential switching is complex (state.vscdb + safe storage).
    // We store a marker + note. User can use this for tracking.
    // In future we can store snapshot of relevant state.
    await setSecret(P, name, JSON.stringify({ note: 'cursor-account-marker', name }));
    addAccount({ provider: P, name, label: label || name });
    console.log('Cursor accounts are tracked via metadata. Full auto-switch may require manual state handling or Cursor restart.');
  },

  async switchTo(name: string) {
    const s = await getSecret(P, name);
    if (!s) throw new Error('No account stored for cursor');

    // Just update the active marker. Real switching for Cursor is non-trivial.
    const { setActive } = await import('../storage/account-store.js');
    setActive(P, name);

    console.log(chalk.yellow?.('Note: Cursor account switching is limited. You may need to restart Cursor or manually manage globalStorage/state.vscdb for full effect.') || 'Note: limited Cursor support.');
  },

  async getCurrentEmail() {
    return undefined; // Cursor doesn't easily expose email here
  },

  async getUsage(accountName?: string) {
    if (accountName) {
      return `Cursor usage for ${accountName}: limited tracking (use Cursor settings or openusage)`;
    }
    return 'Cursor usage: track via Cursor UI or openusage (complex due to internal state.vscdb)';
  },

  async clearCurrent() {
    // Cursor is metadata-only; nothing to clear.
  },

  getLoginCommand() {
    return null;
  },

  async getCurrentCredential() {
    return null;
  },
};
