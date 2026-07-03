import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkSharedState, parseCategories, describeShare } from './shared-state.js';

describe('linkSharedState (symlink shared history/settings into a profile home)', () => {
  let home: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-shared-'));
    saved = {
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
      GROK_HOME: process.env.GROK_HOME,
    };
    process.env.HOME = home;
    // Ensure the default home falls back to ~/.<tool>, not an inherited override.
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    delete process.env.GROK_HOME;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('symlinks existing dirs/files and creates missing dir targets, without fabricating files', () => {
    const def = path.join(home, '.claude');
    fs.mkdirSync(path.join(def, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(def, 'settings.json'), '{"x":1}');
    // 'sessions' dir and 'history.jsonl' file do NOT exist yet.

    const profile = path.join(home, 'profiles', 'claude-work');
    fs.mkdirSync(profile, { recursive: true });

    linkSharedState('claude', profile);

    // existing dir + file -> symlinked to the default home
    expect(fs.lstatSync(path.join(profile, 'projects')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(profile, 'projects'))).toBe(path.join(def, 'projects'));
    expect(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).toBe('{"x":1}');

    // missing dir target is created (so new history lands in the shared home) then linked
    expect(fs.lstatSync(path.join(profile, 'sessions')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(def, 'sessions'))).toBe(true);

    // missing file target is NOT fabricated, so no dangling link is created
    expect(fs.existsSync(path.join(profile, 'history.jsonl'))).toBe(false);
  });

  it('never clobbers a real (non-symlink) entry already in the profile home', () => {
    const def = path.join(home, '.claude');
    fs.mkdirSync(path.join(def, 'projects'), { recursive: true });

    const profile = path.join(home, 'profiles', 'claude-work');
    fs.mkdirSync(path.join(profile, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'projects', 'local.txt'), 'keep me');

    linkSharedState('claude', profile);

    expect(fs.lstatSync(path.join(profile, 'projects')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(profile, 'projects', 'local.txt'), 'utf8')).toBe('keep me');
  });

  it('skips config.toml for cross-provider agent homes but still links session history', () => {
    const def = path.join(home, '.codex');
    fs.mkdirSync(path.join(def, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(def, 'config.toml'), 'model = "x"');

    const agentHome = path.join(home, 'profiles', '.agents', 'codex-work');
    fs.mkdirSync(agentHome, { recursive: true });

    linkSharedState('codex', agentHome, { isCross: true });

    expect(fs.lstatSync(path.join(agentHome, 'sessions')).isSymbolicLink()).toBe(true);
    // config.toml must NOT be linked in cross mode (proxy injection rewrites it)
    expect(fs.existsSync(path.join(agentHome, 'config.toml'))).toBe(false);
  });

  it('links config.toml for same-provider homes', () => {
    const def = path.join(home, '.codex');
    fs.mkdirSync(def, { recursive: true });
    fs.writeFileSync(path.join(def, 'config.toml'), 'model = "x"');

    const profile = path.join(home, 'profiles', 'codex-work');
    fs.mkdirSync(profile, { recursive: true });

    linkSharedState('codex', profile, { isCross: false });

    expect(fs.lstatSync(path.join(profile, 'config.toml')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(profile, 'config.toml'), 'utf8')).toBe('model = "x"');
  });

  it('honors the categories filter: only shares the requested categories', () => {
    const def = path.join(home, '.claude');
    fs.mkdirSync(path.join(def, 'projects'), { recursive: true }); // sessions
    fs.mkdirSync(path.join(def, 'skills'), { recursive: true });   // skills
    fs.writeFileSync(path.join(def, 'settings.json'), '{}');        // settings

    const profile = path.join(home, 'profiles', 'claude-work');
    fs.mkdirSync(profile, { recursive: true });

    linkSharedState('claude', profile, { categories: ['sessions'] });

    expect(fs.existsSync(path.join(profile, 'projects'))).toBe(true);      // sessions -> linked
    expect(fs.existsSync(path.join(profile, 'skills'))).toBe(false);       // skills -> not shared
    expect(fs.existsSync(path.join(profile, 'settings.json'))).toBe(false); // settings -> not shared
  });

  it('shares nothing when categories is an empty array (fully isolated)', () => {
    const def = path.join(home, '.claude');
    fs.mkdirSync(path.join(def, 'projects'), { recursive: true });
    const profile = path.join(home, 'profiles', 'claude-work');
    fs.mkdirSync(profile, { recursive: true });

    linkSharedState('claude', profile, { categories: [] });

    expect(fs.existsSync(path.join(profile, 'projects'))).toBe(false);
  });
});

describe('parseCategories / describeShare', () => {
  it('parses and dedupes valid categories, rejects unknown ones', () => {
    expect(parseCategories('sessions, skills ,sessions')).toEqual(['sessions', 'skills']);
    expect(() => parseCategories('sessions,bogus')).toThrow(/Unknown share categor/);
  });

  it('describes the share value', () => {
    expect(describeShare(undefined)).toBe('shared: sessions, skills, agents, hooks, commands, settings');
    expect(describeShare([])).toBe('isolated: sessions, skills, agents, hooks, commands, settings');
    expect(describeShare(['sessions', 'skills'])).toBe('shared: sessions, skills (isolated: agents, hooks, commands, settings)');
  });
});
