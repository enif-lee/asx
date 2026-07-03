import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function configDir(home: string): string {
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'asx');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'asx');
  return path.join(home, '.config', 'asx');
}
function profileHome(home: string, dirName: string): string {
  return path.join(configDir(home), 'profiles', dirName);
}

describe('secure store (profile-home file backend)', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevAppData: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-secure-store-'));
    prevHome = process.env.HOME;
    prevAppData = process.env.APPDATA;
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('stores the credential in the profile home using the provider native filename', async () => {
    const store = await import('./secure-store.js');

    await store.setSecret('codex', 'work', 'codex-cred');
    await store.setSecret('claude', 'work2', '{"claudeAiOauth":{}}');
    await store.setSecret('zai', 'key1', 'sk-zai');

    expect(fs.readFileSync(profileHome(home, 'codex-work') + '/auth.json', 'utf8')).toBe('codex-cred');
    expect(fs.readFileSync(profileHome(home, 'claude-work2') + '/.credentials.json', 'utf8')).toBe('{"claudeAiOauth":{}}');
    // key/marker providers with no native CLI home use a plain 'credential' file
    expect(fs.readFileSync(profileHome(home, 'zai-key1') + '/credential', 'utf8')).toBe('sk-zai');
  });

  it('round-trips via getSecret and enforces 0600/0700 permissions', async () => {
    const store = await import('./secure-store.js');
    await store.setSecret('codex', 'work', 'codex-cred');

    await expect(store.getSecret('codex', 'work')).resolves.toBe('codex-cred');
    await expect(store.getSecret('codex', 'missing')).resolves.toBeNull();

    if (process.platform !== 'win32') {
      expect(fs.statSync(profileHome(home, 'codex-work')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(profileHome(home, 'codex-work') + '/auth.json').mode & 0o777).toBe(0o600);
    }
  });

  it('deleteSecret removes the whole profile home', async () => {
    const store = await import('./secure-store.js');
    await store.setSecret('codex', 'work', 'codex-cred');
    expect(fs.existsSync(profileHome(home, 'codex-work'))).toBe(true);

    await store.deleteSecret('codex', 'work');
    expect(fs.existsSync(profileHome(home, 'codex-work'))).toBe(false);
  });

  it('renameSecret moves the profile home', async () => {
    const store = await import('./secure-store.js');
    await store.setSecret('codex', 'old', 'codex-cred');

    await store.renameSecret('codex', 'old', 'new');

    expect(fs.existsSync(profileHome(home, 'codex-old'))).toBe(false);
    await expect(store.getSecret('codex', 'new')).resolves.toBe('codex-cred');
  });

  it('renameSecret throws when the source does not exist', async () => {
    const store = await import('./secure-store.js');
    await expect(store.renameSecret('codex', 'nope', 'other')).rejects.toThrow(/No secret found/);
  });
});
