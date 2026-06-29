export interface ProviderAdapter {
  name: string; // 'claude-code' | 'codex' | ...

  // Snapshot the *currently active* credential for this provider into our secure store under `accountName`
  addAccount(accountName: string, label?: string): Promise<void>;

  // Make the named account the active one for the provider (mutate OS store / keychain / file)
  switchTo(accountName: string): Promise<void>;

  // Return current active (best effort)
  getCurrent?(): Promise<string | null>;

  // Try to extract email from current login (used for auto-naming and metadata)
  getCurrentEmail?(): Promise<string | undefined>;

  // Optional usage info string for terminal
  getUsage?(accountName?: string): Promise<string>;

  removeAccount?(accountName: string): Promise<void>;
}
