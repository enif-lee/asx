import fs from 'node:fs';
import { getAsxProfilesDir, getPlatform } from '../utils/platform.js';
import { deleteClaudeKeychainCredential, getClaudeKeychainService, readClaudeKeychainCredential, writeClaudeKeychainCredential } from '../utils/claude-keychain.js';
import { getProfileHome, getProfileCredentialPath } from './profile-home.js';

// Storage policy: each profile owns a persistent 0700 home directory under
// getAsxProfilesDir(). File-based providers keep the credential in that home
// using their native auth filename. Claude on macOS keeps OAuth credentials in
// the profile-specific Keychain service derived from that same home path.

function ensureHome(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function isMacClaude(provider: string): boolean {
  return getPlatform() === 'darwin' && provider.toLowerCase().includes('claude');
}

function claudeProfileService(provider: string, name: string): string {
  return getClaudeKeychainService(getProfileHome(provider, name));
}

export async function setSecret(provider: string, name: string, value: string): Promise<void> {
  if (isMacClaude(provider)) {
    writeClaudeKeychainCredential(claudeProfileService(provider, name), value);
    try { fs.rmSync(getProfileCredentialPath(provider, name), { force: true }); } catch {}
    return;
  }

  ensureHome(getProfileHome(provider, name));
  const p = getProfileCredentialPath(provider, name);
  fs.writeFileSync(p, value, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
}

export async function getSecret(provider: string, name: string): Promise<string | null> {
  if (isMacClaude(provider)) {
    const raw = readClaudeKeychainCredential(claudeProfileService(provider, name));
    if (raw) return raw;
  }

  try {
    const raw = fs.readFileSync(getProfileCredentialPath(provider, name), 'utf8');
    return raw.length ? raw : null;
  } catch {
    return null;
  }
}

export async function deleteSecret(provider: string, name: string): Promise<void> {
  if (isMacClaude(provider)) deleteClaudeKeychainCredential(claudeProfileService(provider, name));
  // Drop the whole profile home so no native state (auth file, cached config)
  // lingers after an account is removed.
  try { fs.rmSync(getProfileHome(provider, name), { recursive: true, force: true }); } catch {}
}

export async function renameSecret(provider: string, oldName: string, newName: string): Promise<void> {
  if (!oldName || !newName || oldName === newName) {
    throw new Error('Invalid rename: old and new names must be different and non-empty');
  }

  const from = getProfileHome(provider, oldName);
  const to = getProfileHome(provider, newName);
  const raw = isMacClaude(provider) ? readClaudeKeychainCredential(claudeProfileService(provider, oldName)) : null;

  if (!fs.existsSync(from) && !raw) {
    throw new Error(`No secret found for ${provider}/${oldName}`);
  }

  if (raw) {
    writeClaudeKeychainCredential(claudeProfileService(provider, newName), raw);
    deleteClaudeKeychainCredential(claudeProfileService(provider, oldName));
  }

  // Same provider -> same native filename, so moving the directory is enough.
  // Overwrite any existing target home (rename allows clobber, matching prior behavior).
  fs.mkdirSync(getAsxProfilesDir(), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  if (fs.existsSync(from)) fs.renameSync(from, to);
}
