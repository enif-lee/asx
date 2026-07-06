import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDesktopLaunch } from './desktop-launcher.js';

function tempApp(name: string): { dir: string; app: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asx-desktop-'));
  const app = path.join(dir, `${name}.app`);
  fs.mkdirSync(app, { recursive: true });
  return { dir, app, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('resolveDesktopLaunch', () => {
  it('prefers Applications app bundles and injects changed env', () => {
    const { dir, app, cleanup } = tempApp('Codex');
    try {
      const launch = resolveDesktopLaunch('codex', { ...process.env, CODEX_HOME: '/tmp/asx-codex' }, ['.'], {
        appDirs: [dir],
        brewList: () => [],
        commandExists: () => true,
      });

      expect(launch.source).toBe('applications');
      expect(launch.cmd).toBe('open');
      expect(launch.args).toEqual([
        '-n',
        '--env',
        'CODEX_HOME=/tmp/asx-codex',
        '-a',
        app,
        '--args',
        '--user-data-dir=/tmp/asx-codex/desktop-user-data',
        '.',
      ]);
    } finally {
      cleanup();
    }
  });

  it('can wait for app bundle launches when the caller needs the app lifetime', () => {
    const { dir, app, cleanup } = tempApp('Codex');
    try {
      const launch = resolveDesktopLaunch('codex', { ...process.env, CODEX_HOME: '/tmp/asx-codex' }, [], {
        appDirs: [dir],
        brewList: () => [],
        commandExists: () => false,
        wait: true,
      });

      expect(launch.args).toEqual([
        '-n',
        '-W',
        '--env',
        'CODEX_HOME=/tmp/asx-codex',
        '-a',
        app,
        '--args',
        '--user-data-dir=/tmp/asx-codex/desktop-user-data',
      ]);
    } finally {
      cleanup();
    }
  });

  it('falls back to Homebrew cask app bundles before CLI launchers', () => {
    const { app, cleanup } = tempApp('Claude');
    try {
      const launch = resolveDesktopLaunch('claude', {}, [], {
        appDirs: [],
        brewList: () => [app],
        commandExists: () => true,
      });

      expect(launch.source).toBe('brew');
      expect(launch.args).toEqual(['-n', '-a', app]);
    } finally {
      cleanup();
    }
  });

  it('injects the Claude Desktop user data env for isolated Claude profiles', () => {
    const { dir, app, cleanup } = tempApp('Claude');
    try {
      const launch = resolveDesktopLaunch('claude', { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/asx-claude' }, [], {
        appDirs: [dir],
        brewList: () => [],
        commandExists: () => false,
      });

      expect(launch.args).toEqual([
        '-n',
        '--env',
        'CLAUDE_CONFIG_DIR=/tmp/asx-claude',
        '--env',
        'CLAUDE_USER_DATA_DIR=/tmp/asx-claude/desktop-user-data',
        '-a',
        app,
      ]);
    } finally {
      cleanup();
    }
  });

  it('falls back to the Codex CLI desktop command', () => {
    const launch = resolveDesktopLaunch('codex', {}, ['.'], {
      appDirs: [],
      brewList: () => [],
      commandExists: (cmd) => cmd === 'codex',
    });

    expect(launch).toEqual({ cmd: 'codex', args: ['app', '.'], source: 'cli' });
  });

  it('errors when the provider has no available desktop launcher', () => {
    expect(() => resolveDesktopLaunch('claude', {}, [], {
      appDirs: [],
      brewList: () => [],
      commandExists: () => false,
    })).toThrow(/No desktop launcher/);
  });
});
