import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type DesktopSpec = {
  appNames: string[];
  casks: string[];
  cli?: string[];
  userDataArgFromEnv?: string;
  userDataDirEnv?: { from: string; key: string };
};

export type DesktopLaunch = {
  cmd: string;
  args: string[];
  source: 'applications' | 'brew' | 'cli';
};

export type ResolveDesktopLaunchOpts = {
  appDirs?: string[];
  brewList?: (cask: string) => string[];
  commandExists?: (cmd: string) => boolean;
  wait?: boolean;
};

const DESKTOP_SPEC: Record<string, DesktopSpec> = {
  codex: { appNames: ['Codex'], casks: ['codex'], cli: ['codex', 'app'], userDataArgFromEnv: 'CODEX_HOME' },
  claude: { appNames: ['Claude'], casks: ['claude'], userDataDirEnv: { from: 'CLAUDE_CONFIG_DIR', key: 'CLAUDE_USER_DATA_DIR' } },
};

function providerKey(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes('claude')) return 'claude';
  return p;
}

function defaultAppDirs(): string[] {
  return ['/Applications', path.join(os.homedir(), 'Applications')];
}

function commandExists(cmd: string): boolean {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function brewList(cask: string): string[] {
  const r = spawnSync('brew', ['list', '--cask', cask], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function appPaths(appNames: string[], appDirs: string[]): string[] {
  return appNames
    .flatMap((name) => appDirs.map((dir) => path.join(dir, `${name}.app`)))
    .filter((p) => fs.existsSync(p));
}

function brewApps(casks: string[], appNames: string[], list: (cask: string) => string[]): string[] {
  const names = new Set(appNames.map((name) => `${name}.app`));
  const apps = casks.flatMap((cask) => list(cask))
    .filter((p) => p.endsWith('.app') && fs.existsSync(p));
  const exact = apps.filter((p) => names.has(path.basename(p)));
  return exact.length ? exact : apps;
}

function userDataArgs(spec: DesktopSpec, env: NodeJS.ProcessEnv): string[] {
  const home = spec.userDataArgFromEnv ? env[spec.userDataArgFromEnv] : undefined;
  return home ? [`--user-data-dir=${path.join(home, 'desktop-user-data')}`] : [];
}

function launchEnv(spec: DesktopSpec, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  const source = spec.userDataDirEnv ? env[spec.userDataDirEnv.from] : undefined;
  if (source && spec.userDataDirEnv) next[spec.userDataDirEnv.key] = path.join(source, 'desktop-user-data');
  return next;
}

function openLaunch(spec: DesktopSpec, app: string, env: NodeJS.ProcessEnv, forwardArgs: string[], source: DesktopLaunch['source'], wait = false): DesktopLaunch {
  const actualEnv = launchEnv(spec, env);
  const envArgs = Object.entries(actualEnv)
    .filter(([k, v]) => v !== undefined && process.env[k] !== v)
    .flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  const appArgs = [...userDataArgs(spec, actualEnv), ...forwardArgs];
  return {
    cmd: 'open',
    args: ['-n', ...(wait ? ['-W'] : []), ...envArgs, '-a', app, ...(appArgs.length ? ['--args', ...appArgs] : [])],
    source,
  };
}

export function resolveDesktopLaunch(
  provider: string,
  env: NodeJS.ProcessEnv,
  forwardArgs: string[],
  opts: ResolveDesktopLaunchOpts = {},
): DesktopLaunch {
  const spec = DESKTOP_SPEC[providerKey(provider)];
  if (!spec) throw new Error(`Desktop exec is not supported for provider '${provider}'.`);

  const app = appPaths(spec.appNames, opts.appDirs || defaultAppDirs())[0];
  if (app) return openLaunch(spec, app, env, forwardArgs, 'applications', opts.wait);

  const brewApp = brewApps(spec.casks, spec.appNames, opts.brewList || brewList)[0];
  if (brewApp) return openLaunch(spec, brewApp, env, forwardArgs, 'brew', opts.wait);

  if (spec.cli && (opts.commandExists || commandExists)(spec.cli[0])) {
    return { cmd: spec.cli[0], args: [...spec.cli.slice(1), ...forwardArgs], source: 'cli' };
  }

  throw new Error(`No desktop launcher found for provider '${provider}'.`);
}
