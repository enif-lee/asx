import fs from 'node:fs';
import { getAsxProfilesDir } from '../utils/platform.js';
import { getProfileHome, getProfileCredentialPath } from './profile-home.js';

// Storage policy: each profile owns a persistent 0700 home directory under
// getAsxProfilesDir(). The credential lives in that home as a 0600 file whose
// name matches the provider's native CLI auth file (see profile-home.ts), so the
// same directory can later be handed to the native binary via its home env var.
// That file is the single source of truth — there is no OS keychain and no
// separate vault. Metadata (email, label, ...) still lives in account-store.

function ensureHome(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

export async function setSecret(provider: string, name: string, value: string): Promise<void> {
  ensureHome(getProfileHome(provider, name));
  const p = getProfileCredentialPath(provider, name);
  fs.writeFileSync(p, value, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
}

export async function getSecret(provider: string, name: string): Promise<string | null> {
  try {
    const raw = fs.readFileSync(getProfileCredentialPath(provider, name), 'utf8');
    return raw.length ? raw : null;
  } catch {
    return null;
  }
}

export async function deleteSecret(provider: string, name: string): Promise<void> {
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

  if (!fs.existsSync(from)) {
    throw new Error(`No secret found for ${provider}/${oldName}`);
  }

  // Same provider -> same native filename, so moving the directory is enough.
  // Overwrite any existing target home (rename allows clobber, matching prior behavior).
  fs.mkdirSync(getAsxProfilesDir(), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
}
