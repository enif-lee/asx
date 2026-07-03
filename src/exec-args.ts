import { resolveShareSelection, type ShareSelectionOpts } from './storage/shared-state.js';

export interface ParsedExecArgs {
  forwardArgs: string[];
  bypass: boolean;
  debug: boolean;
  keepContext: boolean;
  share: { provided: boolean; value?: string[] };
}

function needValue(args: string[], i: number, flag: string): string {
  const value = args[i + 1];
  if (!value || value === '--' || value.startsWith('-')) {
    throw new Error(`${flag} requires categories. Example: ${flag} sessions,skills`);
  }
  return value;
}

function setShareOpt(opts: ShareSelectionOpts, key: keyof ShareSelectionOpts, value: true | string): void {
  if (opts[key] !== undefined) throw new Error('Use only one of --isolated / --shared / --share / --isolate.');
  if (key === 'isolated') opts.isolated = value as true;
  else if (key === 'shared') opts.shared = value as true;
  else if (key === 'share') opts.share = value as string;
  else opts.isolate = value as string;
}

export function parseExecArgs(args: string[], opts: { isCross: boolean; agentProvider?: string }): ParsedExecArgs {
  const forwardArgs: string[] = [];
  const shareOpts: ShareSelectionOpts = {};
  let bypass = false;
  let debug = false;
  let keepContext = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      forwardArgs.push(...args.slice(i + 1));
      break;
    }
    if (arg === '-b' || arg === '--bypass') {
      bypass = true;
      continue;
    }
    if (arg === '-d' || arg === '--debug') {
      debug = true;
      continue;
    }

    if (opts.isCross) {
      if (arg === '-i' || arg === '--isolated') {
        setShareOpt(shareOpts, 'isolated', true);
        continue;
      }
      if (arg === '-s' || arg === '--shared') {
        setShareOpt(shareOpts, 'shared', true);
        continue;
      }
      if (arg === '--share') {
        setShareOpt(shareOpts, 'share', needValue(args, i, '--share'));
        i++;
        continue;
      }
      if (arg.startsWith('--share=')) {
        const value = arg.slice('--share='.length);
        if (!value) throw new Error('--share requires categories. Example: --share sessions,skills');
        setShareOpt(shareOpts, 'share', value);
        continue;
      }
      if (arg === '--isolate') {
        setShareOpt(shareOpts, 'isolate', needValue(args, i, '--isolate'));
        i++;
        continue;
      }
      if (arg.startsWith('--isolate=')) {
        const value = arg.slice('--isolate='.length);
        if (!value) throw new Error('--isolate requires categories. Example: --isolate settings');
        setShareOpt(shareOpts, 'isolate', value);
        continue;
      }
      if (arg === '--keep-context') {
        keepContext = true;
        continue;
      }
    }

    forwardArgs.push(arg);
  }

  return {
    forwardArgs,
    bypass,
    debug,
    keepContext,
    share: resolveShareSelection(shareOpts, opts.isCross ? opts.agentProvider : undefined),
  };
}
