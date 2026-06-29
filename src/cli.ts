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
  .command('add <provider> [name]')
  .description('Snapshot current active creds for <provider> as [name] (login with the real CLI first). If no name given, tries to use email.')
  .action(async (provider: string, name?: string) => {
    const adapter = getAdapter(provider);
    try {
      let finalName = name;
      let email: string | undefined;

      if (!finalName && adapter.getCurrentEmail) {
        email = await adapter.getCurrentEmail();
        if (email) {
          // Default to "personal" when we have email info; email will be stored as metadata
          finalName = 'personal';
        }
      }
      if (!finalName) finalName = 'default';

      await adapter.addAccount(finalName);
      console.log(chalk.green(`Added ${provider}/${finalName}${email ? ` (${email})` : ''}`));
    } catch (e: any) {
      console.error(chalk.red(e.message || e));
      process.exit(1);
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
  .command('remove <provider> <name>')
  .alias('rm')
  .description('Remove a stored account')
  .action(async (provider: string, name: string) => {
    const { removeAccount } = await import('./storage/account-store.js');
    const ok = removeAccount(provider, name);
    if (ok) console.log(chalk.green(`Removed ${provider}/${name}`));
    else console.log('Not found');
  });

program
  .command('usage [provider] [name]')
  .description('Show per-account usage / quota (best effort, see openusage for richer data)')
  .action(async (provider?: string, name?: string) => {
    let providersToShow: string[];
    if (provider) {
      try {
        getAdapter(provider); // validate
        providersToShow = [provider];
      } catch (e) {
        console.log(chalk.red(`Unknown provider: ${provider}`));
        return;
      }
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

      if (name) {
        // specific account requested
        const out = await (adapter.getUsage?.(name) ?? Promise.resolve('no usage impl yet'));
        const activeMark = getActive(p) === name ? chalk.green(' *') : '  ';
        const lines = String(out).split('\n');
        console.log(`${activeMark} ${name}: ${lines[0]}`);
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
  .command('run <provider> <name> [cmd...]')
  .description('Run a command with a specific account active (scoped)')
  .action(async (provider: string, name: string, cmd: string[]) => {
    const adapter = getAdapter(provider);
    try {
      await adapter.switchTo(name); // temp global for the child
      const fullCmd = cmd.length ? cmd.join(' ') : 'echo "switched (no command given)"';
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
