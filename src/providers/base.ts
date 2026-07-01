export interface ProviderAdapter {
  name: string; // 'claude-code' | 'codex' | ...

  // Snapshot (load) the *currently active* credential for this provider into our secure store under `accountName`.
  // (Replaces the previous "add" snapshot behavior.)
  loadCurrent(accountName: string, label?: string): Promise<void>;

  // Make the named account the active one for the provider (mutate OS store / keychain / file)
  switchTo(accountName: string): Promise<void>;

  // Try to extract email from current login (used for auto-naming and metadata)
  getCurrentEmail?(): Promise<string | undefined>;

  // Optional usage info string for terminal
  getUsage?(accountName?: string): Promise<string>;

  // Clear the *local* provider session (keychain entry or file) without revoking server tokens.
  // Used by `asx login` to prepare for a fresh native login flow after saving the current one.
  clearCurrent?(): Promise<void>;

  // Return the native login command (argv) for this provider, or null if not supported.
  // e.g. claude-code returns ['claude', 'auth', 'login']
  getLoginCommand?(): string[] | null;

  // Return the *raw* credential string that is currently active in the *system*
  // (e.g. keychain item, ~/.codex/auth.json, ~/.grok/auth.json, or env for key providers).
  // This is used by `asx list` to mark which stored account matches what the native tool is actually using right now.
  getCurrentCredential?(): Promise<string | null>;


  // True if the stored credential is expired (or within the refresh skew of expiring).
  isExpired?(accountName: string): Promise<boolean>;

  // Refresh (rotate) the stored credential for the account. Returns status + message.
  // needsRelogin = the refresh token is revoked/absent; caller may fall back to login flow.
  refresh?(accountName: string): Promise<{ ok: boolean; message: string; needsRelogin?: boolean }>;
}
