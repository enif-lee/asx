#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAdapter, listKnownProviders } from './providers/index.js';
import * as provIndex from './providers/index.js';
import { listAccounts, getActive, getAccountByName } from './storage/account-store.js';
import { getSecret } from './storage/secure-store.js';
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

// Forge a structurally valid (unsigned) JWT + codex auth.json so the codex binary boots
// under a non-codex profile. Codex parses the id_token's claims locally; real calls hit the proxy.
function fakeCodexAuth(): string {
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = {
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'asx-proxy', chatgpt_plan_type: 'pro' },
    email: 'proxy@asx.local',
  };
  const jwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.sig`;
  return JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: jwt, access_token: jwt, refresh_token: 'asx-proxy-refresh', account_id: 'asx-proxy' }, last_refresh: new Date().toISOString() });
}

// Per-agent facts: native binary, the env var + temp subdir + auth file used to isolate it,
// full-access bypass flags, and the boot stub written when running under a *cross* profile
// (so the binary skips its own login). stub=null → no file needed (grok routes via config.toml).
interface AgentSpec { bin: string; homeEnv: string; sub: string; file: string; bypass: string[]; stub: (() => string) | null; }
const AGENT_SPEC: Record<string, AgentSpec> = {
  codex: { bin: 'codex', homeEnv: 'CODEX_HOME', sub: 'codex', file: 'auth.json', bypass: ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'], stub: fakeCodexAuth },
  claude: { bin: 'claude', homeEnv: 'CLAUDE_CONFIG_DIR', sub: 'claude', file: '.credentials.json', bypass: ['--dangerously-skip-permissions'], stub: () => JSON.stringify({ claudeAiOauth: { accessToken: 'asx-proxy-dummy' } }) },
  grok: { bin: 'grok', homeEnv: 'GROK_HOME', sub: 'grok', file: 'auth.json', bypass: ['--dangerously-skip-permissions'], stub: null },
};
const agentSpec = (provider: string): AgentSpec | undefined => AGENT_SPEC[provider.includes('claude') ? 'claude' : provider];

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

const program = new Command();

program
  .name('asx')
  .description('Multi-account LLM provider switcher (claude, codex, zai, grok, cursor). Credentials via OS keychain. (renamed from "as" to avoid conflict with LLVM as)')
  .version('0.1.0');

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
        if (liveCredential && getSecretFn) {
          try {
            const stored = await getSecretFn(p, a.name);
            if (stored === liveCredential) {
              systemMark = chalk.cyan(' (current in system)');
            }
          } catch {}
        }

        console.log(`${star} ${a.name}${emailPart}${labelPart}${systemMark}`);

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

program
  .command('load [provider] [name]')
  .description('Load (snapshot) currently active credential(s) from provider into asx. If no provider given, auto-detects main providers.')
  .action(async (provider?: string, name?: string) => {
    const { getSecret } = await import('./storage/secure-store.js');
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
async function runLoginFlow(p: string, adapter: any, name?: string): Promise<boolean> {
  const loginCmd = typeof adapter.getLoginCommand === 'function' ? adapter.getLoginCommand() : null;
  if (!loginCmd || loginCmd.length === 0) {
    console.log(chalk.yellow(`Login flow is not supported for provider '${p}'.`));
    console.log(chalk.gray(`For API-key providers (grok, zai, ...) use environment variables or run the native tool then 'asx load ${p} <name>'.`));
    return false;
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
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) console.log(chalk.yellow(`Native login exited with code ${exitCode}.`));

  // 4. Load the newly logged-in session
  try {
    let targetName = name;
    let newEmail: string | undefined;
    if (!targetName && adapter.getCurrentEmail) newEmail = await adapter.getCurrentEmail().catch(() => undefined);
    if (!targetName) targetName = deriveAccountName(newEmail, p);
    await adapter.loadCurrent(targetName);
    console.log(chalk.green(`Loaded ${p}/${targetName} after login.`));
    return true;
  } catch (e: any) {
    console.error(chalk.red(`Failed to load new session: ${e.message || e}`));
    return false;
  }
}

program
  .command('login [provider] [name]')
  .description('Save current session (non-destructively), clear local provider session, launch native login flow, then load the new session.\nProvider is optional when a profile name identifies it: asx login jn.claude')
  .action(async (a?: string, b?: string) => {
    const { provider, name } = resolveProviderName(a, b);
    if (!provider) { console.error(chalk.red('Specify a provider or a profile name. e.g. asx login claude | asx login jn.claude')); process.exit(1); }
    let adapter: any;
    try {
      adapter = getAdapter(provider);
    } catch (e: any) {
      console.error(chalk.red(e.message || e));
      return;
    }
    await runLoginFlow(provider, adapter, name);
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
      if (ok) console.log(chalk.green(`Removed ${prov}/${nm}`));
      else console.log('Not found');
    } catch (e: any) {
      console.error(chalk.red(e.message || e));
    }
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
      const ok = await runLoginFlow(prov, adapter, name);
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
    // persistent dir, then tell the user which env vars to export to use it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `asx-proxy-${frontendProvider}-`));
    // Clean the temp dir on any exit (normal, crash, uncaught), not just Ctrl+C.
    process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
    const injected: NodeJS.ProcessEnv = {};
    await injectProxyEndpoint(frontendProvider, injected, url, dir, backendProvider);

    console.log(chalk.green(`\nASX proxy running: ${chalk.bold(url)}`));
    console.log(chalk.gray(`  backend  = ${backendProvider}/${name}`));
    console.log(chalk.gray(`  frontend = ${frontendProvider} (wire this endpoint speaks)`));
    console.log(`\n${chalk.bold('Point your ' + frontendProvider + ' agent at it:')}`);
    for (const [k, v] of Object.entries(injected)) {
      console.log(`  export ${k}=${JSON.stringify(v)}`);
    }
    if (frontendProvider === 'codex') console.log(chalk.gray(`  then run: codex   (uses the injected CODEX_HOME config)`));
    else if (frontendProvider === 'grok') console.log(chalk.gray(`  then run: grok    (uses the injected GROK_HOME config)`));
    else if (frontendProvider === 'claude') console.log(chalk.gray(`  then run: claude  (uses ANTHROPIC_BASE_URL)`));
    console.log(chalk.gray(`\n  or call directly, e.g.:  curl ${url}/v1/... `));
    console.log(chalk.yellow(`\nPress Ctrl+C to stop.`));

    const shutdown = () => {
      try { proxyHandle.stop(); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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
  .description('Run the native CLI (claude/codex/grok/...) under an isolated profile.\nOptional <target> after name routes via ASX Proxy when providers differ (e.g. asx e ed.codex claude).\nUse -b/--bypass to auto-inject full permission flags per provider.\nExamples:\n  asx e ed.codex\n  asx e ed.codex claude "hello"\n  asx e ed.codex -b "do something dangerous"')
  .option('-b, --bypass', 'Automatically inject full-access permission bypass flags for the target provider')
  .option('-d, --debug', 'Show ASX proxy/exec debug logs (to stderr). Off by default.')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (name: string, options: { bypass?: boolean; debug?: boolean }) => {
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
    const subIdx = argv.findIndex((v, i) => (v === 'exec' || v === 'e') && argv[i + 1] === name);
    const forwardStart = subIdx >= 0 ? subIdx + 2 : argv.length;
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

    const isCurrent = getActive(profileProvider) === accountName;

    let env = { ...process.env };
    let tmpDir: string | null = null;
    let proxyHandle: { url?: string; stop: () => void } | null = null;

    const cleanup = () => {
      if (proxyHandle) {
        try { proxyHandle.stop(); } catch {}
      }
      if (tmpDir && fs.existsSync(tmpDir)) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    };

    try {
      // Auto-refresh the profile credential if expired, before any cred is read/seeded.
      const wantDebug = process.argv.includes('-d') || process.argv.includes('--debug');
      const fresh = await ensureFresh(profileProvider, accountName, wantDebug);
      if (!fresh) {
        console.error(chalk.red(`[asx] ${profileProvider}/${accountName} credential is expired and could not be refreshed. Re-login: asx login ${profileProvider}`));
        process.exit(1);
      }

      // Isolation policy:
      // - Always isolate when cross (different agent vs profile provider)
      // - When not cross, follow the original "isCurrent" logic for the profile.
      const forceIsolation = isCross;
      if (!isCurrent || forceIsolation) {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `asx-${accountName.replace(/[^a-zA-Z0-9_-]/g, '_')}-`));
        fs.chmodSync(tmpDir, 0o700);

        // Isolate the agent binary in tmpDir via its home env var.
        const d = path.join(tmpDir, spec.sub);
        fs.mkdirSync(d, { recursive: true });
        env[spec.homeEnv] = d;

        if (!isCross) {
          // Same provider: copy the profile's real credential into the agent's temp home.
          const cred = await getSecret(profileProvider, accountName);
          if (!cred) {
            console.error(chalk.red(`No stored credential for ${profileProvider}/${accountName}`));
            process.exit(1);
          }
          fs.writeFileSync(path.join(d, spec.file), cred, { mode: 0o600 });
        } else if (spec.stub) {
          // Cross: seed a boot stub so the binary skips its own login (real backend auth is
          // the proxy's). grok has stub=null — its injected config.toml handles auth instead.
          try { fs.writeFileSync(path.join(d, spec.file), spec.stub(), { mode: 0o600 }); } catch {}
        }
      }

      // forwardArgs already prepared above (target consumed if present)
      let forwardArgs = rawAfter;

      // Handle --debug / -d (ASX-level): enable proxy/exec logs, strip from forwarded args.
      const debug = options?.debug || forwardArgs.includes('-d') || forwardArgs.includes('--debug');
      if (debug) {
        process.env.ASX_DEBUG = '1';
        forwardArgs = forwardArgs.filter(a => a !== '-d' && a !== '--debug');
      }

      // Handle --bypass / -b from either options or raw args
      const bypassFromOpts = options?.bypass;
      const bypassFromArgs = forwardArgs.includes('-b') || forwardArgs.includes('--bypass');
      const bypass = bypassFromOpts || bypassFromArgs;

      if (bypass) {
        // Remove the bypass flags from forwarded args
        forwardArgs = forwardArgs.filter(a => a !== '-b' && a !== '--bypass');
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
        const backendCred = await getSecret(profileProvider, accountName);
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
          tmpDir: tmpDir || undefined,
        });

        if (proxyHandle?.url) {
          await injectProxyEndpoint(agentProvider, env, proxyHandle.url, tmpDir ?? undefined, profileProvider);
        }
      }

      dlog(chalk.blue(`[asx exec] agent=${agentProvider} profile=${profileProvider}/${accountName} isolated=${!!tmpDir}${bypass ? ' +bypass' : ''}${isCross ? ' +proxy' : ''}`));
      const child = spawn(nativeBin, forwardArgs, { env, stdio: 'inherit' });

      child.on('exit', (code) => {
        cleanup();
        process.exit(code ?? 0);
      });

      child.on('error', (err) => {
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
const KNOWN_CMDS = new Set(['list', 'ls', 'load', 'login', 'switch', 'rename', 'remove', 'status', 'exec', 'e', 'help']);
const first = process.argv[2];
if (first && !first.startsWith('-') && !KNOWN_CMDS.has(first) && getAccountByName(first)) {
  process.argv.splice(2, 0, 'e');
}

program.parse(process.argv);
