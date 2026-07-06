#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getAdapter, listKnownProviders } from './providers/index.js';
import * as provIndex from './providers/index.js';
import { getClaudeCodeOAuthToken, isClaudeCodeLongLivedToken } from './providers/claude-code.js';
import { listAccounts, getActive, getAccountByName, getAccount, setShare, setProfileType, type AccountRecord } from './storage/account-store.js';
import { getSecret } from './storage/secure-store.js';
import { getProfileHome } from './storage/profile-home.js';
import { linkSharedState, describeShare, resolveShareSelection, SHARE_CATEGORIES, type ShareSelectionOpts } from './storage/shared-state.js';
import { agentScratchHome, crossSessionAgentHome, removeCrossSessionAgentHome } from './storage/agent-home.js';
import { parseExecArgs } from './exec-args.js';
import { resolveDesktopLaunch } from './desktop-launcher.js';
import { dlog } from './utils/log.js';

function getProviderShortName(provider: string): string {
  const p = provider.toLowerCase();
  if (p === 'claude' || p === 'claude-code') return 'claude';
  if (p === 'codex') return 'codex';
  if (p === 'grok') return 'grok';
  if (p === 'cursor') return 'cursor';
  if (p === 'zai') return 'zai';
  // fallback
  return p.replace(/-code$/, '').split('-')[0];
}

function deriveAccountName(email: string | undefined, provider: string): string {
  const local = email ? email.split('@')[0] : 'personal';
  const short = getProviderShortName(provider);
  return `${local}.${short}`;
}

// Per-agent facts: native binary, the env var + temp subdir + auth file used to isolate it,
// full-access bypass flags, and the boot stub written when running under a *cross* profile
// (so the binary skips its own login). stub=null → no file needed (config/env handles auth).
interface AgentSpec { bin: string; homeEnv: string; file: string; bypass: string[]; stub: (() => string) | null; }
const AGENT_SPEC: Record<string, AgentSpec> = {
  codex: { bin: 'codex', homeEnv: 'CODEX_HOME', file: 'auth.json', bypass: ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'], stub: null },
  claude: { bin: 'claude', homeEnv: 'CLAUDE_CONFIG_DIR', file: '.credentials.json', bypass: ['--dangerously-skip-permissions'], stub: () => JSON.stringify({ claudeAiOauth: { accessToken: 'asx-proxy-dummy' } }) },
  grok: { bin: 'grok', homeEnv: 'GROK_HOME', file: 'auth.json', bypass: ['--dangerously-skip-permissions'], stub: null },
};
const agentSpec = (provider: string): AgentSpec | undefined => AGENT_SPEC[provider.includes('claude') ? 'claude' : provider];
const isAgentProvider = (provider: string): boolean => !!agentSpec(provider);

function spawnNative(cmd: string, args: string[], opts: SpawnOptions) {
  return spawn(cmd, args, { ...opts, shell: process.platform === 'win32' });
}

function formatEnvLine(key: string, value: string | undefined): string {
  const v = value ?? '';
  return process.platform === 'win32'
    ? `$env:${key}='${v.replace(/'/g, "''")}'`
    : `export ${key}=${JSON.stringify(v)}`;
}

function seedAgentHome(provider: string, dir: string) {
  if (!provider.includes('claude')) return;
  const p = path.join(dir, '.claude.json');
  let current: any = {};
  try { if (fs.existsSync(p)) current = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  fs.writeFileSync(p, JSON.stringify({ ...current, hasCompletedOnboarding: true }), { mode: 0o600 });
}

function ensureHome700(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

async function isCurrentSystemProfile(provider: string, name: string, adapter: any): Promise<boolean> {
  try {
    const live = await (adapter.getCurrentCredential?.() ?? Promise.resolve(null));
    if (!live) return false;
    const stored = await getSecret(provider, name);
    return stored === live;
  } catch {
    return false;
  }
}

function canShowSharing(account: AccountRecord): boolean {
  return account.profileType !== 'system' && isAgentProvider(account.provider);
}

async function runCommand(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawnNative(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// Refresh the stored credential if the adapter reports it expired. Best-effort; used
// automatically before exec and `ls -u`. Returns true if the credential is usable after.
async function ensureFresh(provider: string, name: string, verbose = false): Promise<boolean> {
  let adapter: any;
  try { adapter = getAdapter(provider); } catch { return true; }
  if (!adapter.isExpired || !adapter.refresh) return true;
  try {
    if (!(await adapter.isExpired(name))) return true;
    if (verbose) console.error(chalk.yellow(`[asx] ${provider}/${name} token expired — refreshing...`));
    const r = await adapter.refresh(name);
    if (verbose) console.error((r.ok ? chalk.gray : chalk.red)(`[asx] refresh ${name}: ${r.message}`));
    return r.ok;
  } catch { return true; }
}

// Resolve (provider, name) from up to two positional args where provider is optional.
//   (a, b)  -> provider=a, name=b            (explicit provider)
//   (name)  -> look up the profile by name   -> provider from the stored account
//   (prov)  -> provider=a, name=undefined    (e.g. `login claude` for a fresh login)
function resolveProviderName(a?: string, b?: string): { provider?: string; name?: string } {
  const norm = (p?: string) => (p ? (normalizeProviderSync(p) || p.toLowerCase()) : undefined);
  if (a && b) return { provider: norm(a), name: b };
  if (!a) return {};
  // Prefer an existing account name (so an account whose name equals a provider string
  // is still resolvable); otherwise treat the token as a provider (e.g. `login claude`).
  const acct = getAccountByName(a);
  if (acct) return { provider: acct.provider, name: a };
  if (isKnownProviderSync(a)) return { provider: norm(a) };
  return { provider: norm(a) }; // unknown token; treat as provider and let downstream error
}
// sync wrappers around the (already-sync) provider helpers, imported lazily elsewhere
function normalizeProviderSync(p: string): string | undefined { return provIndex.normalizeProvider(p); }
function isKnownProviderSync(p: string): boolean { return provIndex.isKnownProvider(p); }

// Attach shared/isolation flags to a command (login, load, sharing) uniformly.
function withShareFlags(cmd: Command): Command {
  return cmd
    .option('--isolated', 'Fully isolate this profile (share nothing from the default provider home)')
    .option('--shared', 'Share the provider safe-default state categories')
    .option('--share <categories>', `Share only these comma-separated categories (${SHARE_CATEGORIES.join(', ')})`)
    .option('--isolate <categories>', 'Share everything except these comma-separated categories');
}

type ShareOpts = ShareSelectionOpts;
// Resolve share flags into the value to persist. Returns { provided:false } when no
// flag was passed (leave the profile's setting untouched). `value` follows the store
// convention: undefined => safe defaults, [] => isolated, [...] => that subset.
function resolveShareFlags(o: ShareOpts, provider?: string): { provided: boolean; value?: string[] } {
  return resolveShareSelection(o, provider);
}

const program = new Command();

program
  .name('asx')
  .description('Multi-account LLM provider switcher (claude, codex, zai, grok, cursor). Credentials live in provider-native profile stores. (renamed from "as" to avoid conflict with LLVM as)')
  .version('0.3.0');

program
  .command('list [provider]')
  .alias('ls')
  .description('List accounts per provider (or all). Use -u/--usage to show live quota. Use -d/--debug to show stored credentials.')
  .option('-u, --usage', 'Show usage/quota bars for each listed account')
  .option('-d, --debug', 'Show stored credentials (debug mode)')
  .action(async (provider?: string, opts: { usage?: boolean; debug?: boolean } = {}) => {
    let provs: string[] = [];
    let singleName: string | undefined;

    if (provider) {
      try {
        getAdapter(provider);
        provs = [provider];
      } catch {
        // Maybe user passed a global account name
        try {
          const acct = getAccountByName(provider);
          if (acct) {
            provs = [acct.provider];
            singleName = provider;
          } else {
            console.log(chalk.red(`Unknown provider or name: ${provider}`));
            return;
          }
        } catch {
          console.log(chalk.red(`Unknown provider: ${provider}`));
          return;
        }
      }
    } else {
      provs = listKnownProviders();
    }

    for (const p of provs) {
      const accts = singleName
        ? listAccounts(p).filter(a => a.name === singleName)
        : listAccounts(p);
      const active = getActive(p);
      console.log(chalk.bold(`${p}:`));
      if (accts.length === 0) {
        if (provider && !singleName) console.log('  (none)');
        continue;
      }
      const adapter = getAdapter(p);

      // Detect which (if any) of our stored accounts matches the *actual* credential
      // currently loaded in the system (keychain / ~/.codex/auth.json / ~/.grok/auth.json etc.)
      let liveCredential: string | null = null;
      try {
        liveCredential = await (adapter.getCurrentCredential?.() ?? Promise.resolve(null));
      } catch {}

      let getSecretFn: ((provider: string, name: string) => Promise<string | null>) | null = null;
      if (liveCredential) {
        try {
          const mod = await import('./storage/secure-store.js');
          getSecretFn = mod.getSecret;
        } catch {}
      }

      for (const a of accts) {
        const star = a.name === active ? chalk.green(' *') : '  ';
        const emailPart = a.email ? chalk.gray(` <${a.email}>`) : '';
        const labelPart = a.label && a.label !== a.name ? ` (${a.label})` : '';

        let systemMark = '';
        let currentInSystem = false;
        if (liveCredential && getSecretFn) {
          try {
            const stored = await getSecretFn(p, a.name);
            if (stored === liveCredential) {
              currentInSystem = true;
              systemMark = chalk.cyan(' (current in system)');
            }
          } catch {}
        }

        const sharePart = canShowSharing(a) && !currentInSystem ? chalk.yellow(` [${describeShare(a.share, p)}]`) : '';

        console.log(`${star} ${a.name}${emailPart}${labelPart}${systemMark}${sharePart}`);

        if (opts.debug) {
          try {
            const { getSecret } = await import('./storage/secure-store.js');
            const cred = await getSecret(p, a.name);
            if (cred) {
              console.log(`    credential: ${cred}`);
            } else {
              console.log(`    credential: (none)`);
            }
          } catch (e: any) {
            console.log(`    credential: error - ${e.message || e}`);
          }
        }

        if (opts.usage) {
          try {
            await ensureFresh(p, a.name, false); // auto-refresh expired token before reading usage
            const usage = await (adapter.getUsage?.(a.name) ?? Promise.resolve(''));
            const lines = String(usage).trim().split('\n');
            for (const line of lines) {
              if (line) console.log(`    ${line}`);
            }
          } catch {}
        }
      }
    }
  });

withShareFlags(program
  .command('load [provider] [name]')
  .description('Load (snapshot) currently active credential(s) from provider into asx. If no provider given, auto-detects main providers.'))
  .action(async (provider?: string, name?: string, opts: ShareOpts = {}) => {
    const { getSecret } = await import('./storage/secure-store.js');
    let share: { provided: boolean; value?: string[] };
    try { share = resolveShareFlags(opts); }
    catch (e: any) { console.error(chalk.red(e.message || e)); process.exit(1); }
    if (share.provided) {
      console.error(chalk.red('System profiles created by `asx load` cannot use --shared/--isolated/--share/--isolate.'));
      process.exit(1);
    }
    // No provider: scan every known agent configured on this machine (not a fixed list).
    const targets: Array<{provider: string, explicitName?: string}> = provider
      ? [{ provider, explicitName: name }]
      : listKnownProviders().map(p => ({ provider: p }));

    let any = false;
    for (const { provider: p, explicitName } of targets) {
      let adapter: any;
      try {
        adapter = getAdapter(p);
      } catch {
        continue;
      }

      try {
        // Read the live (native) credential for this provider. In auto mode, skip
        // providers with no configured agent quietly.
        const localCred = adapter.getCurrentCredential ? await adapter.getCurrentCredential().catch(() => null) : null;
        if (!provider && !localCred) continue;

        // Resolve the email of the credential being loaded (for dedup + naming).
        let email: string | undefined;
        if (adapter.getCurrentEmail) {
          email = await adapter.getCurrentEmail().catch(() => undefined);
        }

        // Email-based dedup: if a profile with this email already exists for the
        // provider, update it in place instead of creating a differently-named
        // duplicate (e.g. ed.claude vs e-ed.claude for the same e-ed@ account).
        let finalName = explicitName;
        let existingCred: string | null = null;
        if (email) {
          const existing = listAccounts(p).find(a => a.email && a.email.toLowerCase() === email!.toLowerCase());
          if (existing && (!explicitName || explicitName === existing.name)) {
            finalName = existing.name;
            existingCred = await getSecret(p, existing.name).catch(() => null);
          } else if (existing && explicitName && explicitName !== existing.name) {
            console.log(chalk.yellow(`Note: ${email} is already stored as ${p}/${existing.name}; saving under ${explicitName} too.`));
          }
        }
        if (!finalName) finalName = deriveAccountName(email, p);
        if (!existingCred) existingCred = await getSecret(p, finalName).catch(() => null);

        // Prefer the local credential: loadCurrent() snapshots the native cred, so a
        // stored profile that differs is overwritten with the local one.
        await adapter.loadCurrent(finalName);
        setProfileType(p, finalName, 'system');
        any = true;

        const verb = existingCred === null ? 'Loaded'
          : (localCred && existingCred !== localCred) ? 'Updated (local credential preferred)'
          : 'Unchanged';
        console.log(chalk.green(`${verb} ${p}/${finalName}${email ? ` (${email})` : ''}`));
      } catch (e: any) {
        const msg = e.message || String(e);
        if (!provider && (msg.includes('No active') || msg.includes('No ') || msg.includes('not found') || msg.includes('found') || msg.includes('already used'))) {
          continue;
        }
        console.error(chalk.red(`Failed for ${p}: ${msg}`));
        if (provider) process.exit(1);
      }
    }
    if (!provider && !any) console.log(chalk.gray('No configured agents found to load.'));
  });

// Non-destructive re-login flow: save current session, clear local, run native login,
// load the new session. Reused by `asx login` and by `asx refresh` when a token is revoked.
// Returns the final account name on success, or null on failure.
async function runLoginFlow(p: string, adapter: any, name?: string, opts: { longLived?: boolean; systemHome?: boolean } = {}): Promise<string | null> {
  const isClaude = p === 'claude' || p === 'claude-code';
  if (isClaude && opts.longLived && typeof adapter.loadLongLivedToken === 'function') {
    const loginCmd = ['claude', 'setup-token'];
    console.log(chalk.cyan(`Launching native token setup: ${loginCmd.join(' ')}`));
    const exitCode = await runCommand(loginCmd[0], loginCmd.slice(1));
    if (exitCode !== 0) {
      console.log(chalk.yellow(`Native token setup exited with code ${exitCode}.`));
      return null;
    }

    const targetName = name || deriveAccountName(undefined, p);
    const token = process.env.ASX_CLAUDE_CODE_OAUTH_TOKEN || await (async () => {
      const { password } = await import('@inquirer/prompts');
      return password({ message: 'Paste Claude long-lived token:' });
    })();
    if (!token.trim()) {
      console.error(chalk.red('No token provided.'));
      return null;
    }
    await adapter.loadLongLivedToken(targetName, token);
    console.log(chalk.green(`Loaded ${p}/${targetName} long-lived token.`));
    return targetName;
  }

  if (p === 'zai' && typeof adapter.login === 'function') {
    const targetName = name || deriveAccountName(undefined, p);
    try {
      await adapter.login(targetName);
      console.log(chalk.green(`Loaded ${p}/${targetName} after login.`));
      return targetName;
    } catch (e: any) {
      console.error(chalk.red(`Failed to login ${p}/${targetName}: ${e.message || e}`));
      return null;
    }
  }

  const loginCmd = typeof adapter.getLoginCommand === 'function' ? adapter.getLoginCommand() : null;
  if (!loginCmd || loginCmd.length === 0) {
    console.log(chalk.yellow(`Login flow is not supported for provider '${p}'.`));
    console.log(chalk.gray(`For API-key providers without a login flow, use environment variables or run the native tool then 'asx load ${p} <name>'.`));
    return null;
  }

  if (isClaude && !opts.systemHome) {
    const targetName = name || deriveAccountName(undefined, p);
    const spec = agentSpec('claude')!;
    // Log in directly into the profile home so Claude uses the profile-scoped
    // credential store (macOS Keychain hash or .credentials.json fallback).
    const dir = getProfileHome('claude', targetName);
    ensureHome700(dir);
    seedAgentHome('claude', dir);
    try { fs.unlinkSync(path.join(dir, spec.file)); } catch {}

    const [cmd, ...args] = loginCmd;
    console.log(chalk.cyan(`Launching native login: ${loginCmd.join(' ')} (CLAUDE_CONFIG_DIR=${dir})`));
    console.log(chalk.gray('Complete the login in the opened browser/terminal...'));
    const exitCode = await runCommand(cmd, args, { env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    if (exitCode !== 0) console.log(chalk.yellow(`Native login exited with code ${exitCode}.`));

    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = dir;
      await adapter.loadCurrent(targetName);
      console.log(chalk.green(`Loaded ${p}/${targetName} after login.`));
      return targetName;
    } catch (e: any) {
      console.error(chalk.red(`Failed to load new session: ${e.message || e}`));
      return null;
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  }

  const loginInHome = async (targetName: string, home: string | null) => {
    const [cmd, ...args] = loginCmd;
    const spec = agentSpec(p);
    const env = home && spec ? { ...process.env, [spec.homeEnv]: home } : process.env;
    console.log(chalk.cyan(`Launching native login: ${loginCmd.join(' ')}${home && spec ? ` (${spec.homeEnv}=${home})` : ''}`));
    console.log(chalk.gray('Complete the login in the opened browser/terminal...'));
    const exitCode = await runCommand(cmd, args, { env });
    if (exitCode !== 0) console.log(chalk.yellow(`Native login exited with code ${exitCode}.`));

    const prev = spec ? process.env[spec.homeEnv] : undefined;
    try {
      if (home && spec) process.env[spec.homeEnv] = home;
      await adapter.loadCurrent(targetName);
      console.log(chalk.green(`Loaded ${p}/${targetName} after login.`));
      return targetName;
    } catch (e: any) {
      console.error(chalk.red(`Failed to load new session: ${e.message || e}`));
      return null;
    } finally {
      if (spec) {
        if (prev === undefined) delete process.env[spec.homeEnv];
        else process.env[spec.homeEnv] = prev;
      }
    }
  };

  // Existing current-in-system profiles keep the provider's normal home path.
  if (opts.systemHome) {
    const targetName = name || deriveAccountName(undefined, p);
    return loginInHome(targetName, null);
  }

  // Native agent providers logged in through `asx login` get an isolated profile home.
  const spec = agentSpec(p);
  if (spec) {
    const targetName = name || deriveAccountName(undefined, p);
    const dir = getProfileHome(p, targetName);
    ensureHome700(dir);
    seedAgentHome(p, dir);
    try { fs.unlinkSync(path.join(dir, spec.file)); } catch {}
    return loginInHome(targetName, dir);
  }

  // 1. Save existing session (non-destructive)
  try {
    let prevEmail: string | undefined;
    if (adapter.getCurrentEmail) prevEmail = await adapter.getCurrentEmail().catch(() => undefined);
    const prevName = deriveAccountName(prevEmail, p);
    await adapter.loadCurrent(prevName).catch((e: any) => {
      const m = String(e?.message || e);
      if (!/No active|No .*found|not found/i.test(m)) throw e;
    });
  } catch { /* non-fatal */ }

  // 2. Clear only the local session
  if (typeof adapter.clearCurrent === 'function') {
    try { await adapter.clearCurrent(); } catch {}
  }

  // 3. Launch native login (interactive)
  const [cmd, ...args] = loginCmd;
  console.log(chalk.cyan(`Launching native login: ${loginCmd.join(' ')}`));
  console.log(chalk.gray('Complete the login in the opened browser/terminal...'));
  const exitCode = await runCommand(cmd, args);
  if (exitCode !== 0) console.log(chalk.yellow(`Native login exited with code ${exitCode}.`));

  // 4. Load the newly logged-in session
  try {
    let targetName = name;
    let newEmail: string | undefined;
    if (!targetName && adapter.getCurrentEmail) newEmail = await adapter.getCurrentEmail().catch(() => undefined);
    if (!targetName) targetName = deriveAccountName(newEmail, p);
    await adapter.loadCurrent(targetName);
    console.log(chalk.green(`Loaded ${p}/${targetName} after login.`));
    return targetName;
  } catch (e: any) {
    console.error(chalk.red(`Failed to load new session: ${e.message || e}`));
    return null;
  }
}

withShareFlags(program
  .command('login [provider] [name]')
  .description('Login and store a new account. Claude defaults to native access/refresh tokens in an isolated CLAUDE_CONFIG_DIR; use --long-lived for setup-token.\nProvider is optional when a profile name identifies it: asx login jn.claude')
  .option('--long-lived', 'For Claude only: run `claude setup-token` and store CLAUDE_CODE_OAUTH_TOKEN instead of native access/refresh tokens'))
  .action(async (a?: string, b?: string, opts: { longLived?: boolean } & ShareOpts = {}) => {
    const { provider, name } = resolveProviderName(a, b);
    if (!provider) { console.error(chalk.red('Specify a provider or a profile name. e.g. asx login claude | asx login jn.claude')); process.exit(1); }
    let adapter: any;
    try {
      adapter = getAdapter(provider);
    } catch (e: any) {
      console.error(chalk.red(e.message || e));
      return;
    }
    const storedProvider = adapter.name || provider;
    let share: { provided: boolean; value?: string[] };
    try { share = resolveShareFlags(opts, storedProvider); }
    catch (e: any) { console.error(chalk.red(e.message || e)); process.exit(1); }
    const systemHome = !!name && await isCurrentSystemProfile(storedProvider, name, adapter);
    if (systemHome && share!.provided) {
      console.error(chalk.red('Current system profiles cannot use --shared/--isolated/--share/--isolate.'));
      process.exit(1);
    }
    const finalName = await runLoginFlow(storedProvider, adapter, name, { ...opts, systemHome });
    if (finalName) {
      setProfileType(storedProvider, finalName, systemHome ? 'system' : 'isolated');
      if (!systemHome && share!.provided) setShare(storedProvider, finalName, share!.value);
    }
  });

program
  .command('switch <nameOrProvider> [name]')
  .alias('s')
  .description('Switch the active credential to the named account.\nProvider is optional when the profile name identifies it: asx switch ed.codex')
  .action(async (a: string, b?: string) => {
    const { provider, name } = resolveProviderName(a, b);
    if (!provider || !name) { console.error(chalk.red('Specify a profile name. e.g. asx switch ed.codex | asx switch codex ed.codex')); process.exit(1); }
    try {
      const adapter = getAdapter(provider);
      await adapter.switchTo(name);
      console.log(chalk.green(`Switched ${provider} -> ${name}`));
    } catch (e: any) {
      console.error(chalk.red(e.message || e));
      process.exit(1);
    }
  });

program
  .command('rename <from> <to>')
  .description('Rename an existing account from one name to another')
  .action(async (fromName: string, toName: string) => {
    try {
      const acct = getAccountByName(fromName);
      if (!acct) {
        console.error(chalk.red(`Account "${fromName}" not found`));
        return;
      }
      const prov = acct.provider;

      // Rename in secure vault first
      const { renameSecret } = await import('./storage/secure-store.js');
      await renameSecret(prov, fromName, toName);

      // Then rename in metadata store (also updates active markers)
      const { renameAccount } = await import('./storage/account-store.js');
      renameAccount(fromName, toName);

      console.log(chalk.green(`Renamed ${fromName} → ${toName} (${prov})`));
    } catch (e: any) {
      console.error(chalk.red(e.message || e));
    }
  });

program
  .command('remove [args...]')
  .alias('rm')
  .description('Remove a stored account. Provider can be omitted when name is globally unique.')
  .action(async (args: string[]) => {
    const { removeAccount, removeAccountByName, getAccountByName } = await import('./storage/account-store.js');
    try {
      let prov: string | undefined;
      let nm: string;
      if (args.length === 1) {
        nm = args[0];
      } else if (args.length === 2) {
        prov = args[0];
        nm = args[1];
      } else {
        console.error(chalk.red('Usage: asx remove [provider] <name>'));
        return;
      }
      if (!prov) {
        const acct = getAccountByName(nm);
        if (!acct) {
          console.log('Not found');
          return;
        }
        prov = acct.provider;
      }
      const ok = removeAccount(prov, nm);
      if (ok) {
        const { deleteSecret } = await import('./storage/secure-store.js');
        await deleteSecret(prov, nm);
        console.log(chalk.green(`Removed ${prov}/${nm}`));
      } else console.log('Not found');
    } catch (e: any) {
      console.error(chalk.red(e.message || e));
    }
  });

withShareFlags(program
  .command('sharing <name>')
  .description(`Show or change what a profile shares from the provider's default home.\nCategories vary by provider. With no flags, prints the current setting.\nExamples:\n  asx sharing ed.claude --isolated\n  asx sharing ed.claude --share sessions,skills\n  asx sharing ed.claude --isolate settings`))
  .action(async (name: string, opts: ShareOpts = {}) => {
    const acc = getAccountByName(name);
    if (!acc) { console.error(chalk.red(`No account found with name "${name}"`)); process.exit(1); }
    if (!isAgentProvider(acc.provider)) {
      console.error(chalk.red(`Sharing is only available for agent profiles (claude, codex, grok). ${acc.provider}/${acc.name} has no agent home to share.`));
      process.exit(1);
    }
    const adapter = getAdapter(acc.provider);
    if (acc.profileType === 'system' || await isCurrentSystemProfile(acc.provider, acc.name, adapter)) {
      console.error(chalk.red(`Sharing is not available for system profile ${acc.provider}/${acc.name}.`));
      process.exit(1);
    }
    let share: { provided: boolean; value?: string[] };
    try { share = resolveShareFlags(opts, acc.provider); }
    catch (e: any) { console.error(chalk.red(e.message || e)); process.exit(1); }
    if (share!.provided) {
      setShare(acc.provider, acc.name, share!.value);
      const home = getProfileHome(acc.provider, acc.name);
      ensureHome700(home);
      linkSharedState(acc.provider, home, { isCross: false, categories: share!.value });
      console.log(chalk.green(`Updated sharing for ${acc.provider}/${acc.name}`));
    }
    const cur = getAccount(acc.provider, acc.name);
    console.log(`${acc.provider}/${acc.name}: ${describeShare(cur?.share, acc.provider)}`);
  });

program
  .command('status [provider]')
  .description('Show current active account(s)')
  .action(async (provider?: string) => {
    const provs = provider ? [provider] : listKnownProviders();
    for (const p of provs) {
      const act = getActive(p);
      console.log(`${p}: ${act ? chalk.green(act) : chalk.gray('(none)')}`);
    }
  });

program
  .command('refresh <nameOrProvider> [name]')
  .description('Refresh (rotate) a stored credential using its refresh token.\nProvider is optional when the profile name identifies it: asx refresh jn.claude\nIf the refresh token is revoked/expired, falls back to the interactive re-login flow (use --no-login to disable).\nExamples:\n  asx refresh jn.claude\n  asx refresh claude jn.claude\n  asx refresh codex ed.codex')
  .option('--no-login', 'Do not fall back to the interactive login flow when the refresh token is dead')
  .action(async (a: string, b: string | undefined, opts: { login?: boolean }) => {
    const { provider: prov, name } = resolveProviderName(a, b);
    if (!prov || !name) { console.error(chalk.red('Specify a profile name. e.g. asx refresh jn.claude | asx refresh claude jn.claude')); process.exit(1); }
    let adapter: any;
    try { adapter = getAdapter(prov); } catch { console.error(chalk.red(`Unknown provider: ${prov}`)); process.exit(1); }
    if (!adapter.refresh) { console.error(chalk.red(`Refresh not supported for '${prov}'.`)); process.exit(1); }
    if (!getAccountByName(name)) { console.error(chalk.red(`No account found with name "${name}"`)); process.exit(1); }
    const r = await adapter.refresh(name);
    if (r.ok) { console.log(chalk.green(`✓ ${name}: ${r.message}`)); process.exit(0); }

    console.log(chalk.red(`✗ ${name}: ${r.message}`));
    // Token dead → offer the interactive re-login flow (explicit command only).
    if (r.needsRelogin && opts.login !== false) {
      console.log(chalk.yellow(`\nRefresh token can't be used. Starting re-login for ${prov}/${name}...`));
      const acc = getAccount(prov, name);
      const systemHome = acc?.profileType === 'system' || await isCurrentSystemProfile(prov, name, adapter);
      const ok = await runLoginFlow(prov, adapter, name, { systemHome });
      process.exit(ok ? 0 : 1);
    }
    process.exit(1);
  });

program
  .command('proxy <name> <frontend>')
  .description('Start a standalone ASX proxy: <name> profile is the backend, <frontend> is the agent wire it speaks.\nPrints the endpoint URL and how to point the frontend agent at it. Runs until Ctrl+C.\nExample:\n  asx proxy ed.claude codex   # claude backend, codex-wire frontend')
  .action(async (name: string, frontend: string) => {
    const acct = getAccountByName(name);
    if (!acct) { console.error(chalk.red(`No account found with name "${name}"`)); process.exit(1); }
    const backendProvider = acct.provider;
    const frontendProvider = (provIndex.normalizeProvider(frontend) || frontend.toLowerCase());
    if (!['claude', 'codex', 'grok'].includes(frontendProvider)) {
      console.error(chalk.red(`Unsupported frontend '${frontend}'. Use claude, codex, or grok.`)); process.exit(1);
    }

    // Refresh the backend credential if expired, then load it.
    await ensureFresh(backendProvider, name, true);
    const backendCred = await getSecret(backendProvider, name);
    if (!backendCred) { console.error(chalk.red(`No stored credential for ${backendProvider}/${name}`)); process.exit(1); }

    const proxyMod = await import('./proxy/index.js');
    const { injectProxyEndpoint } = await import('./proxy/inject.js');
    const proxyHandle = await proxyMod.startProxyForExec({
      sourceProvider: frontendProvider,      // the wire the proxy accepts
      targetProvider: backendProvider,       // the real backend (profile)
      targetCredential: { apiKey: backendCred, raw: backendCred, type: backendProvider === 'claude' ? 'anthropic' : 'openai' } as any,
    });
    const url = proxyHandle.url!;

    // Reuse the exec injection to produce the exact config/env the frontend needs, into a
    // persistent per-frontend scratch home under the asx config dir, then tell the user
    // which env vars to export to use it. The config is regenerated each run.
    const dir = agentScratchHome(frontendProvider, name);
    const injected: NodeJS.ProcessEnv = {};
    await injectProxyEndpoint(frontendProvider, injected, url, dir, backendProvider);

    console.log(chalk.green(`\nASX proxy running: ${chalk.bold(url)}`));
    console.log(chalk.gray(`  backend  = ${backendProvider}/${name}`));
    console.log(chalk.gray(`  frontend = ${frontendProvider} (wire this endpoint speaks)`));
    console.log(`\n${chalk.bold('Point your ' + frontendProvider + ' agent at it:')}`);
    for (const [k, v] of Object.entries(injected)) {
      console.log(`  ${formatEnvLine(k, v)}`);
    }
    if (frontendProvider === 'codex') console.log(chalk.gray(`  then run: codex   (uses the injected CODEX_HOME config)`));
    else if (frontendProvider === 'grok') console.log(chalk.gray(`  then run: grok    (uses the injected GROK_HOME config)`));
    else if (frontendProvider === 'claude') console.log(chalk.gray(`  then run: claude  (uses ANTHROPIC_BASE_URL)`));
    console.log(chalk.gray(`\n  or call directly, e.g.:  curl ${url}/v1/... `));
    console.log(chalk.yellow(`\nPress Ctrl+C to stop.`));

    const shutdown = () => {
      try { proxyHandle.stop(); } catch {}
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

function getBypassFlags(provider: string): string[] {
  return agentSpec(provider)?.bypass ?? [];
}

program
  .command('exec <name>')
  .alias('e')
  .description('Run the native CLI (claude/codex/grok/...) under a profile.\nOptional <target> after name routes via ASX Proxy when providers differ (e.g. asx e ed.codex claude).\nUse --desktop to launch the desktop app with the profile env when supported.\nCross-provider context flags: -s/--shared, -i/--isolated, --share <categories>, --isolate <categories>, --keep-context. Use -- before raw agent flags.\nUse -b/--bypass to auto-inject full permission flags per provider.\nExamples:\n  asx e ed.codex\n  asx e ed.codex --desktop .\n  asx e personal.zai codex --share sessions,skills "hello"\n  asx e personal.zai codex -- -s raw-agent-flag\n  asx e ed.codex -b "do something dangerous"')
  .option('-b, --bypass', 'Automatically inject full-access permission bypass flags for the target provider')
  .option('-d, --debug', 'Show ASX proxy/exec debug logs (to stderr). Off by default.')
  .option('--desktop', 'Launch the desktop app for the target provider when supported')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (name: string, options: { bypass?: boolean; debug?: boolean; desktop?: boolean }) => {
    const { getAccountByName } = await import('./storage/account-store.js');
    const acct = getAccountByName(name);
    if (!acct) {
      console.error(chalk.red(`No account found with name "${name}"`));
      process.exit(1);
    }

    const profileProvider = acct.provider;
    const accountName = acct.name;

    // --- Determine agent vs backend according to spec ---
    // When both profile and provider specified:
    //   - agent (binary to launch) follows the specified provider
    //   - backend follows the profile
    // When provider omitted: both follow the profile's provider.
    const { normalizeProvider, isKnownProvider } = await import('./providers/index.js');
    const argv = process.argv;
    const subIdx = argv.findIndex((v) => v === 'exec' || v === 'e');
    const nameIdx = subIdx >= 0 ? argv.indexOf(name, subIdx + 1) : -1;
    const forwardStart = nameIdx >= 0 ? nameIdx + 1 : argv.length;
    let rawAfter = argv.slice(forwardStart).filter((a): a is string => typeof a === 'string');

    let specifiedProvider: string | undefined;
    const possible = rawAfter[0];
    if (possible && !possible.startsWith('-') && isKnownProvider(possible)) {
      specifiedProvider = normalizeProvider(possible);
      rawAfter = rawAfter.slice(1);
    }

    const agentProvider = specifiedProvider || profileProvider;
    const isCross = !!specifiedProvider && normalizeProvider(specifiedProvider) !== normalizeProvider(profileProvider);

    const spec = agentSpec(agentProvider);
    if (!spec) {
      console.error(chalk.red(`Exec is not supported for provider '${agentProvider}'.`));
      process.exit(1);
    }
    const nativeBin = spec.bin;

    let env = { ...process.env };
    let proxyHandle: { url?: string; stop: () => void } | null = null;
    let crossContextHome: string | null = null;
    let keepContext = false;
    let profileSecret: string | null | undefined;
    const readProfileSecret = async () => {
      if (profileSecret === undefined) profileSecret = await getSecret(profileProvider, accountName);
      return profileSecret;
    };

    // Same-provider exec uses the profile home as the store. Cross-provider exec
    // creates a short-lived context home and a proxy; cleanup handles both.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (proxyHandle) {
        try { proxyHandle.stop(); } catch {}
      }
      if (crossContextHome && !keepContext) {
        try { removeCrossSessionAgentHome(crossContextHome); }
        catch (e: any) { dlog('[asx exec] failed to remove cross context:', e?.message || e); }
      }
    };

    try {
      const execArgs = parseExecArgs(rawAfter, { isCross, agentProvider });
      keepContext = execArgs.keepContext || process.env.ASX_KEEP_CONTEXT === '1';
      const desktop = options?.desktop || execArgs.desktop;

      // Auto-refresh the profile credential if expired, before any cred is read/seeded.
      const wantDebug = options?.debug || execArgs.debug;
      const fresh = await ensureFresh(profileProvider, accountName, wantDebug);
      if (!fresh) {
        console.error(chalk.red(`[asx] ${profileProvider}/${accountName} credential is expired and could not be refreshed. Re-login: asx login ${profileProvider}`));
        process.exit(1);
      }
      let claudeLongLivedToken: string | null = null;
      if (normalizeProvider(profileProvider) === 'claude') {
        const raw = await readProfileSecret();
        if (raw && isClaudeCodeLongLivedToken(raw)) claudeLongLivedToken = getClaudeCodeOAuthToken(raw);
      }
      if (!isCross && normalizeProvider(agentProvider) === 'claude' && claudeLongLivedToken) {
        env.CLAUDE_CODE_OAUTH_TOKEN = claudeLongLivedToken;
      }
      const profileAdapter = getAdapter(profileProvider);
      const systemProfile = acct.profileType === 'system' || await isCurrentSystemProfile(profileProvider, accountName, profileAdapter);
      if (!isCross) {
        if (systemProfile) {
          // System profiles intentionally use the provider's normal user-level
          // home (~/.codex, ~/.claude, ~/.grok). No env override, no symlink setup.
          const live = await (profileAdapter.getCurrentCredential?.() ?? Promise.resolve(null));
          const stored = await readProfileSecret();
          if (stored && live && stored !== live) {
            console.error(chalk.red(`${profileProvider}/${accountName} is a system profile but is not current in system. Run: asx switch ${accountName}`));
            process.exit(1);
          }
        } else {
        // Same provider: the profile home already holds the credential at the
        // native filename (SSOT). Point the binary at it directly — no copy.
        const home = getProfileHome(profileProvider, accountName);
        ensureHome700(home);
        env[spec.homeEnv] = home;
        seedAgentHome(agentProvider, home);
        // Share the categories this profile opted into (default: safe set) from the
        // provider's default home so the isolated profile isn't a blank slate.
        linkSharedState(profileProvider, home, { isCross: false, categories: acct.share });

        // A long-lived token is injected via env instead of a credential file.
        if (!(normalizeProvider(agentProvider) === 'claude' && claudeLongLivedToken)) {
          const cred = await readProfileSecret();
          if (!cred) {
            console.error(chalk.red(`No stored credential for ${profileProvider}/${accountName}`));
            process.exit(1);
          }
          // cred already lives at getProfileCredentialPath(profileProvider, accountName),
          // which equals <home>/<native file>. Nothing to materialize.
        }
        }
      } else {
        // Cross: the agent binary runs under a fresh context home with a dummy
        // stub so it skips its own login; the real backend auth is the proxy's.
        const home = crossSessionAgentHome(agentProvider, accountName);
        crossContextHome = home;
        env[spec.homeEnv] = home;
        seedAgentHome(agentProvider, home);
        // Share the agent's own session history/settings (but not config.toml —
        // the proxy injection rewrites that below), honoring this run's choice.
        linkSharedState(agentProvider, home, { isCross: true, categories: execArgs.share.provided ? execArgs.share.value : undefined });
        if (spec.stub) {
          // grok has stub=null — its injected config.toml handles auth instead.
          try { fs.writeFileSync(path.join(home, spec.file), spec.stub(), { mode: 0o600 }); } catch {}
        }
        if (keepContext) console.error(chalk.gray(`[asx] keeping cross context: ${home}`));
      }

      // forwardArgs already prepared above (target consumed if present)
      let forwardArgs = execArgs.forwardArgs;

      // Handle --debug / -d (ASX-level): enable proxy/exec logs, strip from forwarded args.
      const debug = options?.debug || execArgs.debug;
      if (debug) {
        process.env.ASX_DEBUG = '1';
      }

      // Handle --bypass / -b from either options or raw args
      const bypass = options?.bypass || execArgs.bypass;

      if (bypass && !desktop) {
        const bypassFlags = getBypassFlags(agentProvider);
        forwardArgs = [...bypassFlags, ...forwardArgs];
      }

      // --- ASX Proxy cross-provider handling ---
      // agent (binary) = specified provider
      // backend (actual calls + cred) = profile
      if (isCross) {
        dlog(chalk.blue(`[asx exec] cross profile=${profileProvider} agent=${agentProvider} (using proxy) (profile=${accountName})`));
        const proxyMod = await import('./proxy/index.js');
        const { injectProxyEndpoint } = await import('./proxy/inject.js');

        // Profile provides the backend credential
        const backendCred = await readProfileSecret();
        if (!backendCred) {
          console.error(chalk.red(`No stored credential for profile ${profileProvider}/${accountName}`));
          process.exit(1);
        }

        proxyHandle = await proxyMod.startProxyForExec({
          // What the launched agent will speak (incoming to proxy)
          sourceProvider: agentProvider,
          // What the backend actually is (profile's provider)
          targetProvider: profileProvider,
          targetCredential: { apiKey: backendCred, raw: backendCred, type: profileProvider === 'claude' ? 'anthropic' : 'openai' } as any,
        });

        if (proxyHandle?.url) {
          // The agent's home (already set as env[spec.homeEnv]) is where codex/grok
          // proxy config.toml is written; injectClaudeProxy uses env vars only.
          await injectProxyEndpoint(agentProvider, env, proxyHandle.url, env[spec.homeEnv], profileProvider);
        }
      }

      const launch = desktop
        ? resolveDesktopLaunch(agentProvider, env, forwardArgs, { wait: isCross })
        : { cmd: nativeBin, args: forwardArgs, source: 'cli' as const };
      dlog(chalk.blue(`[asx exec] agent=${agentProvider} profile=${profileProvider}/${accountName} isolated=${!!env[spec.homeEnv]}${bypass && !desktop ? ' +bypass' : ''}${isCross ? ' +proxy' : ''}${desktop ? ` +desktop(${launch.source})` : ''}`));
      const child = spawnNative(launch.cmd, launch.args, { env, stdio: 'inherit' });
      const handleSignal = (signal: NodeJS.Signals) => {
        cleanup();
        try { child.kill(signal); } catch {}
        process.exit(signal === 'SIGINT' ? 130 : 143);
      };
      process.once('SIGINT', handleSignal);
      process.once('SIGTERM', handleSignal);
      const removeSignalHandlers = () => {
        process.off('SIGINT', handleSignal);
        process.off('SIGTERM', handleSignal);
      };

      child.on('exit', (code) => {
        removeSignalHandlers();
        cleanup();
        process.exit(code ?? 0);
      });

      child.on('error', (err) => {
        removeSignalHandlers();
        cleanup();
        console.error(chalk.red(err.message || err));
        process.exit(1);
      });

    } catch (e: any) {
      cleanup();
      console.error(chalk.red(e.message || e));
      process.exit(1);
    }
  });

// Default command: `asx <account> [provider] [args]` -> `asx e <account> ...`
// when the first token is a stored account name rather than a subcommand.
const KNOWN_CMDS = new Set(['list', 'ls', 'load', 'login', 'switch', 'rename', 'remove', 'status', 'exec', 'e', 'sharing', 'help']);
const first = process.argv[2];
if (first && !first.startsWith('-') && !KNOWN_CMDS.has(first) && getAccountByName(first)) {
  process.argv.splice(2, 0, 'e');
}

program.parse(process.argv);
