#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAdapter, listKnownProviders } from './providers/index.js';
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
    const mainProviders = ['claude', 'codex', 'grok', 'cursor'];

    const targets: Array<{provider: string, explicitName?: string}> = [];
    if (!provider) {
      for (const p of mainProviders) {
        targets.push({ provider: p });
      }
    } else {
      targets.push({ provider, explicitName: name });
    }

    for (const { provider: p, explicitName } of targets) {
      let adapter: any;
      try {
        adapter = getAdapter(p);
      } catch {
        continue;
      }

      try {
        let finalName = explicitName;
        let email: string | undefined;

        if (!finalName && adapter.getCurrentEmail) {
          email = await adapter.getCurrentEmail().catch(() => undefined);
        }

        if (!finalName) {
          finalName = deriveAccountName(email, p);
        }

        await adapter.loadCurrent(finalName);
        console.log(chalk.green(`Loaded ${p}/${finalName}${email ? ` (${email})` : ''}`));
      } catch (e: any) {
        const msg = e.message || String(e);
        if (!provider && (msg.includes('No active') || msg.includes('No ') || msg.includes('not found') || msg.includes('found') || msg.includes('already used'))) {
          continue;
        }
        console.error(chalk.red(`Failed for ${p}: ${msg}`));
        if (provider) process.exit(1);
      }
    }
  });

program
  .command('login <provider> [name]')
  .description('Save current session (non-destructively), clear local provider session, launch native login flow, then load the new session.')
  .action(async (provider: string, name?: string) => {
    const p = provider.toLowerCase();

    let adapter: any;
    try {
      adapter = getAdapter(p);
    } catch (e: any) {
      console.error(chalk.red(e.message || e));
      return;
    }

    const loginCmd = typeof adapter.getLoginCommand === 'function' ? adapter.getLoginCommand() : null;
    if (!loginCmd || loginCmd.length === 0) {
      console.log(chalk.yellow(`Login flow is not supported for provider '${p}'.`));
      console.log(chalk.gray(`For API-key providers (grok, zai, ...) use environment variables or run the native tool then 'asx load ${p} <name>'.`));
      return;
    }

    // 1. Save existing session (the key non-destructive step)
    try {
      let prevName: string;
      let prevEmail: string | undefined;
      if (adapter.getCurrentEmail) {
        prevEmail = await adapter.getCurrentEmail().catch(() => undefined);
      }
      prevName = deriveAccountName(prevEmail, p);
      // Best-effort: ignore "no current" errors
      await adapter.loadCurrent(prevName).catch((e: any) => {
        const m = String(e?.message || e);
        if (!/No active|No .*found|not found/i.test(m)) throw e;
      });
    } catch (e: any) {
      // non-fatal for login flow
    }

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

    if (exitCode !== 0) {
      console.log(chalk.yellow(`Native login exited with code ${exitCode}.`));
    }

    // 4. Load the newly logged-in session
    try {
      let targetName = name;
      let newEmail: string | undefined;
      if (!targetName && adapter.getCurrentEmail) {
        newEmail = await adapter.getCurrentEmail().catch(() => undefined);
      }
      if (!targetName) {
        targetName = deriveAccountName(newEmail, p);
      }

      await adapter.loadCurrent(targetName);
      console.log(chalk.green(`Loaded ${p}/${targetName} after login.`));
    } catch (e: any) {
      console.error(chalk.red(`Failed to load new session: ${e.message || e}`));
    }
  });

program
  .command('switch <provider> <name>')
  .alias('s')
  .description('Switch the active credential for provider to the named account')
  .action(async (provider: string, name: string) => {
    const adapter = getAdapter(provider);
    try {
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

function getBypassFlags(provider: string): string[] {
  if (provider === 'claude' || provider === 'claude-code') {
    return ['--dangerously-skip-permissions'];
  }
  if (provider === 'codex') {
    return ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'];
  }
  if (provider === 'grok') {
    return ['--dangerously-skip-permissions'];
  }
  return [];
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

    const nativeBin = agentProvider.includes('claude') ? 'claude'
      : agentProvider === 'codex' ? 'codex'
      : agentProvider === 'grok' ? 'grok'
      : null;

    if (!nativeBin) {
      console.error(chalk.red(`Exec is not supported for provider '${agentProvider}'.`));
      process.exit(1);
    }

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
      // Isolation policy:
      // - Always isolate when cross (different agent vs profile provider)
      // - When not cross, follow the original "isCurrent" logic for the profile.
      const forceIsolation = isCross;
      if (!isCurrent || forceIsolation) {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `asx-${accountName.replace(/[^a-zA-Z0-9_-]/g, '_')}-`));
        fs.chmodSync(tmpDir, 0o700);

        if (!isCross) {
          // Same provider: we can safely copy the profile's credential into the agent's temp dir
          const cred = await getSecret(profileProvider, accountName);
          if (!cred) {
            console.error(chalk.red(`No stored credential for ${profileProvider}/${accountName}`));
            process.exit(1);
          }

          if (agentProvider === 'codex') {
            const d = path.join(tmpDir, 'codex');
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, 'auth.json'), cred, { mode: 0o600 });
            env.CODEX_HOME = d;
          } else if (agentProvider.includes('claude')) {
            const d = path.join(tmpDir, 'claude');
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, '.credentials.json'), cred, { mode: 0o600 });
            env.CLAUDE_CONFIG_DIR = d;
          } else if (agentProvider === 'grok') {
            const d = path.join(tmpDir, 'grok');
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, 'auth.json'), cred, { mode: 0o600 });
            env.GROK_HOME = d;
          }
        } else {
          // Cross case: create temp dir for the *agent* (to isolate its local state).
          // Seed a minimal "logged in" state for the agent binary so it doesn't force
          // its own login/welcome screen. The proxy will handle the real backend auth
          // using the profile's credential.
          if (agentProvider === 'codex') {
            const d = path.join(tmpDir, 'codex');
            fs.mkdirSync(d, { recursive: true });
            env.CODEX_HOME = d;
            // Seed a Codex auth.json so the binary boots without a login screen. It validates
            // the id_token as a structurally valid JWT, so a bare string won't do — forge a
            // well-formed (unsigned) JWT with far-future expiry. Real backend auth is the proxy's.
            let codexAuth: string;
            if (profileProvider === 'codex') {
              codexAuth = (await getSecret(profileProvider, accountName)) || fakeCodexAuth();
            } else {
              codexAuth = fakeCodexAuth();
            }
            try {
              fs.writeFileSync(path.join(d, 'auth.json'), codexAuth, { mode: 0o600 });
            } catch {}
          } else if (agentProvider.includes('claude')) {
            const d = path.join(tmpDir, 'claude');
            fs.mkdirSync(d, { recursive: true });
            env.CLAUDE_CONFIG_DIR = d;
            // Seed a minimal credentials so Claude Code skips full sign-in when using gateway token.
            const dummyCred = JSON.stringify({
              claudeAiOauth: { accessToken: 'asx-proxy-dummy' }
            });
            try {
              fs.writeFileSync(path.join(d, '.credentials.json'), dummyCred, { mode: 0o600 });
            } catch {}
          } else if (agentProvider === 'grok') {
            // No auth.json needed: injected config.toml uses a custom model with a dummy api_key,
            // so headless `grok -p` skips login entirely and routes to the proxy. (verified)
            const d = path.join(tmpDir, 'grok');
            fs.mkdirSync(d, { recursive: true });
            env.GROK_HOME = d;
          }
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
