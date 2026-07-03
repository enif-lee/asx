import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crossSessionAgentHome, removeCrossSessionAgentHome } from './agent-home.js';

describe('cross session agent homes', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevAppData: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-agent-home-'));
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

  it('creates distinct per-run homes and removes only guarded session homes', () => {
    const one = crossSessionAgentHome('codex', 'personal.zai', 'run-one');
    const two = crossSessionAgentHome('codex', 'personal.zai', 'run-two');

    expect(one).not.toBe(two);
    expect(one).toContain(path.join('profiles', '.agents', 'sessions', 'codex-personal.zai-run-one'));
    expect(fs.existsSync(one)).toBe(true);

    removeCrossSessionAgentHome(one);
    expect(fs.existsSync(one)).toBe(false);
    expect(fs.existsSync(two)).toBe(true);
    expect(() => removeCrossSessionAgentHome(path.dirname(two))).toThrow(/Refusing/);
    expect(() => removeCrossSessionAgentHome(path.join(home, 'outside'))).toThrow(/Refusing/);
  });
});
