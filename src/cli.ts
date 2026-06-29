#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { getAdapter, listKnownProviders } from './providers/index.js';
import { listAccounts, getActive, getNextAccount } from './storage/account-store.js';


const program = new Command();

program
  .name('asx')
  .description('Multi-account LLM provider switcher (claude-code, codex, z-ai, grok, cursor). Credentials via OS keychain. (renamed from "as" to avoid conflict with LLVM as)')
  .version('0.1.0');

program
  .command('list [provider]')
  .alias('ls')
  .description('List accounts per provider (or all)')
  .action(async (provider?: string) => {
    const provs = provider ? [provider] : listKnownProviders();
    for (const p of provs) {
      const accts = listAccounts(p);
      const active = getActive(p);
      console.log(chalk.bold(`${p}:`));
      if (accts.length === 0) {
        console.log('  (none)');
      } else {
        for (const a of accts) {
          const star = a.name === active ? chalk.green(' *') : '  ';
          const emailPart = a.email ? chalk.gray(` <${a.email}>`) : '';
          const labelPart = a.label && a.label !== a.name ? ` (${a.label})` : '';
          console.log(`${star} ${a.name}${emailPart}${labelPart}`);
        }
      }
    }
  });

program
  .command('add [provider] [name]')
  .description('Snapshot current active creds. If no provider given, auto-detects and adds for main providers (claude-code, codex, grok, cursor). Name is optional (defaults to email localpart or "personal").')
  .action(async (provider?: string, name?: string) => {
    const mainProviders = ['claude-code', 'codex', 'grok', 'cursor'];

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
          email = await adapter.getCurrentEmail();
          if (email) {
            // Use email local part for better default (helps uniqueness)
            finalName = email.split('@')[0] || 'personal';
          }
        }
        if (!finalName) finalName = 'personal';

        // For auto-add, try to pick a unique name to avoid conflicts on common names like "personal"
        if (!explicitName && !provider) {
          const existing = listAccounts().filter(a => a.name === finalName);
          if (existing.length > 0) {
            const short = p.split('-')[0];
            finalName = `${finalName}-${short}`;
          }
        }

        await adapter.addAccount(finalName);
        console.log(chalk.green(`Added ${p}/${finalName}${email ? ` (${email})` : ''}`));
      } catch (e: any) {
        const msg = e.message || String(e);
        if (!provider && (msg.includes('No active') || msg.includes('No ') || msg.includes('not found') || msg.includes('found') || msg.includes('already used'))) {
          // auto mode: silently skip
          continue;
        }
        console.error(chalk.red(`Failed for ${p}: ${msg}`));
        if (provider) process.exit(1);
      }
    }
  });

program
  .command('switch <provider> <name>')
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
  .command('usage [provider] [name]')
  .description('Show per-account usage / quota (best effort, see openusage for richer data). Supports usage <name> for unique names.')
  .action(async (provider?: string, name?: string) => {
    let providersToShow: string[] = [];
    let specificName: string | undefined = name;

    if (provider) {
      try {
        getAdapter(provider);
        providersToShow = [provider];
      } catch (e) {
        // provider arg might actually be a global name
        const { getAccountByName } = await import('./storage/account-store.js');
        try {
          const acct = getAccountByName(provider);
          if (acct) {
            providersToShow = [acct.provider];
            specificName = provider;
          } else {
            console.log(chalk.red(`Unknown provider or name: ${provider}`));
            return;
          }
        } catch {
          console.log(chalk.red(`Unknown provider: ${provider}`));
          return;
        }
      }
    } else if (name) {
      // usage <name> ? but signature has [provider][name], rare
      providersToShow = listKnownProviders();
      specificName = name;
    } else {
      providersToShow = listKnownProviders();
    }

    let showedAnything = false;

    for (const p of providersToShow) {
      const accts = listAccounts(p);
      if (accts.length === 0) {
        if (provider) {
          console.log(chalk.yellow(`No accounts for ${p}.`));
        }
        continue;
      }

      showedAnything = true;
      const adapter = getAdapter(p);

      console.log(chalk.bold(`${p}:`));

      const specific = specificName;
      if (specific) {
        // specific account requested (may be global name)
        const out = await (adapter.getUsage?.(specific) ?? Promise.resolve('no usage impl yet'));
        const activeMark = getActive(p) === specific ? chalk.green(' *') : '  ';
        const lines = String(out).split('\n');
        console.log(`${activeMark} ${specific}: ${lines[0]}`);
        for (let i = 1; i < lines.length; i++) {
          console.log(`    ${lines[i]}`);
        }
      } else {
        // show all accounts for this provider
        for (const a of accts) {
          const out = await (adapter.getUsage?.(a.name) ?? Promise.resolve('no usage impl yet'));
          const active = getActive(p) === a.name ? chalk.green(' *') : '  ';
          const lines = String(out).split('\n');
          console.log(`${active} ${a.name}: ${lines[0]}`);
          for (let i = 1; i < lines.length; i++) {
            console.log(`    ${lines[i]}`);
          }
        }
      }
    }

    if (!showedAnything) {
      if (provider) {
        // already handled above if no accounts
      } else {
        console.log('No accounts registered. Use `asx add <provider> [name]` first.');
      }
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
  .command('run <spec> [cmd...]')
  .description('Run a command with a specific account. Primary: "run <name> -- <cmd>" (resolves provider from unique name). Legacy also supported: "run <provider> <name> -- <cmd>"')
  .action(async (spec: string, cmdParts: string[]) => {
    let provider: string;
    let name: string;
    const commandParts = cmdParts || [];

    if (spec.includes('/')) {
      [provider, name] = spec.split('/', 2);
    } else if (listKnownProviders().includes(spec) && commandParts.length > 0) {
      // legacy without -- or with
      provider = spec;
      name = commandParts.shift()!;
    } else {
      // new provider-less by unique name
      name = spec;
      const { getAccountByName } = await import('./storage/account-store.js');
      const acct = getAccountByName(name);
      if (!acct) {
        console.error(chalk.red(`No account found with name "${name}"`));
        process.exit(1);
      }
      provider = acct.provider;
    }

    const adapter = getAdapter(provider);
    try {
      await adapter.switchTo(name); // temp global for the child
      const fullCmd = commandParts.length ? commandParts.join(' ') : 'echo "switched (no command given)"';
      console.log(chalk.blue(`Running under ${provider}/${name}: ${fullCmd}`));
      execSync(fullCmd, { stdio: 'inherit', shell: true } as any);
    } catch (e: any) {
      console.error(chalk.red(e.message || e));
    }
  });

// Shortcut commands for quick switching + cycling
// cc = claude-code, cx = codex, gk = grok, cs = cursor
const shortcutMap: Record<string, string> = {
  cc: 'claude-code',
  cx: 'codex',
  gk: 'grok',
  cs: 'cursor',
};

Object.entries(shortcutMap).forEach(([short, provider]) => {
  program
    .command(short)
    .argument('[name]', 'account name (if omitted, cycles to next)')
    .description(`Quick switch for ${provider} (cycle if no name)`)
    .action(async (name?: string) => {
      // Try to get adapter; cursor may not be fully implemented yet
      let adapter: any;
      try {
        adapter = getAdapter(provider);
      } catch {
        console.log(chalk.yellow(`Provider '${provider}' not fully registered yet. Using metadata only.`));
      }

      try {
        let target = name;
        if (!target) {
          target = getNextAccount(provider) || undefined;
          if (!target) {
            console.log(chalk.yellow(`No accounts registered for ${provider}. Use 'asx add ${provider} <name>' first.`));
            return;
          }
          console.log(chalk.cyan(`Cycling ${provider} → ${target}`));
        }

        if (adapter) {
          await adapter.switchTo(target);
        } else {
          // Fallback: just update active marker (for cursor etc.)
          const { setActive } = await import('./storage/account-store.js');
          setActive(provider, target);
        }
        console.log(chalk.green(`Switched ${provider} → ${target}`));
      } catch (e: any) {
        console.error(chalk.red(e.message || e));
        process.exit(1);
      }
    });
});

import { execSync } from 'node:child_process';

program.parse(process.argv);
