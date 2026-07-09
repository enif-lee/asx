import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { piAdapter } from './pi.js';
import { getSecret } from '../storage/secure-store.js';
import { listAccounts, removeAccount } from '../storage/account-store.js';

describe('pi provider adapter', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevPiDir: string | undefined;
  let prevXdg: string | undefined;
  let prevAppData: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-pi-'));
    prevHome = process.env.HOME;
    prevPiDir = process.env.PI_CODING_AGENT_DIR;
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevAppData = process.env.APPDATA;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    // Point Pi system home at the temp tree
    const agentDir = path.join(home, '.pi', 'agent');
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    // Drop any accounts we registered for pi
    for (const a of listAccounts().filter((x) => x.provider === 'pi')) {
      removeAccount('pi', a.name);
    }
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevPiDir;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('loadCurrent snapshots auth.json and switchTo restores it', async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const auth = {
      anthropic: { type: 'api_key', key: 'sk-test-anthropic' },
      openai: { type: 'api_key', key: 'sk-test-openai', email: 'pi@example.com' },
    };
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });

    await piAdapter.loadCurrent('work.pi');
    const stored = await getSecret('pi', 'work.pi');
    expect(JSON.parse(stored!)).toEqual(auth);

    // Mutate system file, then switch back
    fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}', { mode: 0o600 });
    await piAdapter.switchTo('work.pi');
    const live = fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8');
    expect(JSON.parse(live)).toEqual(auth);

    const current = await piAdapter.getCurrentCredential?.();
    expect(JSON.parse(current!)).toEqual(auth);

    const email = await piAdapter.getCurrentEmail?.();
    expect(email).toBe('pi@example.com');
  });

  it('loadCurrent errors when auth.json is missing', async () => {
    await expect(piAdapter.loadCurrent('missing.pi')).rejects.toThrow(/No Pi auth found/);
  });
});
