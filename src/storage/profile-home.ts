import path from 'node:path';
import { getAsxProfilesDir } from '../utils/platform.js';

// The native auth filename each provider's CLI reads inside its home directory.
// Providers with a real native CLI home use that CLI's own filename so the same
// directory can be handed to the binary via its home env var (CODEX_HOME etc.).
// Providers without a native home (key/marker providers) use a plain 'credential'
// file. Key = normalized provider (claude-code -> claude, xai -> grok).
const NATIVE_CRED_FILE: Record<string, string> = {
  claude: '.credentials.json',
  codex: 'auth.json',
  grok: 'auth.json',
};

function normalizeProviderKey(provider: string): string {
  const k = provider.toLowerCase();
  if (k.includes('claude')) return 'claude';
  if (k === 'xai') return 'grok';
  return k;
}

export function nativeCredFile(provider: string): string {
  return NATIVE_CRED_FILE[normalizeProviderKey(provider)] || 'credential';
}

// Filesystem-safe directory name for a profile. Keep this stable: it is the
// on-disk identity of the profile home, so the same (provider, name) must always
// map to the same directory.
export function safeProfileDirName(provider: string, name: string): string {
  return `${normalizeProviderKey(provider)}-${name}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// Absolute path to a profile's home directory (created lazily by the store).
export function getProfileHome(provider: string, name: string): string {
  return path.join(getAsxProfilesDir(), safeProfileDirName(provider, name));
}

// Absolute path to the credential file inside a profile's home.
export function getProfileCredentialPath(provider: string, name: string): string {
  return path.join(getProfileHome(provider, name), nativeCredFile(provider));
}
