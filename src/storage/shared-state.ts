import fs from 'node:fs';
import path from 'node:path';
import { getHomeDotDir } from '../utils/platform.js';

// Categories an isolated agent profile can independently share from / isolate
// against the user's system provider home. A profile stores the subset it shares (see account-store
// `share`): undefined => the safe default categories, [] => fully isolated.
export const SHARE_CATEGORIES = ['sessions', 'skills', 'agents', 'hooks', 'settings', 'state', 'cache', 'logs'] as const;
export type ShareCategory = (typeof SHARE_CATEGORIES)[number];

type Entry =
  | { name: string; type: 'dir' | 'file'; cat: ShareCategory }
  | { match: RegExp; type: 'file'; cat: ShareCategory };
type ResolvedEntry = { name: string; type: 'dir' | 'file'; cat: ShareCategory };

const EXPLICIT_ONLY = new Set<ShareCategory>(['state', 'cache', 'logs']);

// State each provider keeps in its home, tagged by category. Auth files and tmp/process
// scratch remain isolated. Runtime state is explicit opt-in only; default sharing stays safe.
const SHARED: Record<string, Entry[]> = {
  claude: [
    { name: 'projects', type: 'dir', cat: 'sessions' },
    { name: 'sessions', type: 'dir', cat: 'sessions' },
    { name: 'shell-snapshots', type: 'dir', cat: 'sessions' },
    { name: 'file-history', type: 'dir', cat: 'sessions' },
    { name: 'plans', type: 'dir', cat: 'sessions' },
    { name: 'tasks', type: 'dir', cat: 'sessions' },
    { name: 'todos', type: 'dir', cat: 'sessions' },
    { name: 'history.jsonl', type: 'file', cat: 'sessions' },
    { name: 'skills', type: 'dir', cat: 'skills' },
    { name: 'agents', type: 'dir', cat: 'agents' },
    { name: 'hooks', type: 'dir', cat: 'hooks' },
    { name: 'plugins', type: 'dir', cat: 'settings' },
    { name: 'settings.json', type: 'file', cat: 'settings' },
    { name: 'CLAUDE.md', type: 'file', cat: 'settings' },
  ],
  codex: [
    { name: 'sessions', type: 'dir', cat: 'sessions' },
    { name: 'archived_sessions', type: 'dir', cat: 'sessions' },
    { name: 'history.jsonl', type: 'file', cat: 'sessions' },
    { name: 'session_index.jsonl', type: 'file', cat: 'sessions' },
    { name: 'skills', type: 'dir', cat: 'skills' },
    { name: 'rules', type: 'dir', cat: 'settings' },
    { name: 'plugins', type: 'dir', cat: 'settings' },
    { name: 'AGENTS.md', type: 'file', cat: 'settings' },
    { name: 'config.toml', type: 'file', cat: 'settings' },
    { name: '.codex-global-state.json', type: 'file', cat: 'state' },
    { name: '.codex-global-state.json.bak', type: 'file', cat: 'state' },
    { name: '.app-server-state-reconciled-v1', type: 'file', cat: 'state' },
    { name: '.personality_migration', type: 'file', cat: 'state' },
    { name: 'sqlite', type: 'dir', cat: 'state' },
    { match: /^(state|goals|memories)_\d+\.sqlite(?:-(?:shm|wal))?$/, type: 'file', cat: 'state' },
    { match: /^logs_\d+\.sqlite(?:-(?:shm|wal))?$/, type: 'file', cat: 'logs' },
    { name: 'log', type: 'dir', cat: 'logs' },
    { name: 'cache', type: 'dir', cat: 'cache' },
    { name: 'vendor_imports', type: 'dir', cat: 'cache' },
    { match: /^models_cache.*\.json$/, type: 'file', cat: 'cache' },
  ],
  grok: [
    { name: 'sessions', type: 'dir', cat: 'sessions' },
    { name: 'projects', type: 'dir', cat: 'sessions' },
    { name: 'active_sessions.json', type: 'file', cat: 'sessions' },
    { name: 'skills', type: 'dir', cat: 'skills' },
    { name: 'completions', type: 'dir', cat: 'settings' },
    { name: 'config.toml', type: 'file', cat: 'settings' },
  ],
};

// config.toml is provider config that asx *rewrites* for cross-provider runs (proxy
// injection). It must never be symlinked there or we'd clobber the user's real config.
const INJECTED_WHEN_CROSS = new Set(['config.toml']);

function providerKey(provider: string): string {
  const k = provider.toLowerCase();
  if (k.includes('claude')) return 'claude';
  if (k === 'xai') return 'grok';
  return k;
}

function defaultHomeFor(provider: string): string | null {
  switch (providerKey(provider)) {
    case 'claude': return getHomeDotDir('claude');
    case 'codex': return getHomeDotDir('codex');
    case 'grok': return getHomeDotDir('grok');
    default: return null;
  }
}

// Validate + normalize a comma-separated category list. Throws on unknown names.
export function parseCategories(csv: string): ShareCategory[] {
  const parts = csv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const invalid = parts.filter((p) => !SHARE_CATEGORIES.includes(p as ShareCategory));
  if (invalid.length) {
    throw new Error(`Unknown share categor${invalid.length > 1 ? 'ies' : 'y'}: ${invalid.join(', ')}. Valid: ${SHARE_CATEGORIES.join(', ')}`);
  }
  return [...new Set(parts)] as ShareCategory[];
}

export function supportedShareCategories(provider: string): ShareCategory[] {
  const cats = new Set((SHARED[providerKey(provider)] || []).map((e) => e.cat));
  return SHARE_CATEGORIES.filter((c) => cats.has(c));
}

export function defaultShareCategories(provider?: string): ShareCategory[] {
  const cats = provider ? supportedShareCategories(provider) : SHARE_CATEGORIES;
  return cats.filter((c) => !EXPLICIT_ONLY.has(c));
}

export function parseCategoriesForProvider(csv: string, provider: string): ShareCategory[] {
  const cats = parseCategories(csv);
  const supported = supportedShareCategories(provider);
  const unsupported = cats.filter((c) => !supported.includes(c));
  if (unsupported.length) {
    throw new Error(`${provider} does not support share categor${unsupported.length > 1 ? 'ies' : 'y'}: ${unsupported.join(', ')}. Valid: ${supported.join(', ')}`);
  }
  return cats;
}

export interface ShareSelectionOpts { isolated?: boolean; shared?: boolean; share?: string; isolate?: string }

export function resolveShareSelection(o: ShareSelectionOpts, provider?: string): { provided: boolean; value?: string[] } {
  const set = [o.isolated, o.shared, o.share, o.isolate].filter((x) => x !== undefined);
  if (set.length === 0) return { provided: false };
  if (set.length > 1) throw new Error('Use only one of --isolated / --shared / --share / --isolate.');
  if (o.isolated) return { provided: true, value: [] };
  if (o.shared) return { provided: true, value: undefined };
  const parse = provider ? (s: string) => parseCategoriesForProvider(s, provider) : parseCategories;
  if (o.share !== undefined) return { provided: true, value: parse(o.share) };
  const exclude = parse(o.isolate!);
  const base = defaultShareCategories(provider);
  return { provided: true, value: base.filter((c) => !exclude.includes(c)) };
}

function resolveEntries(entries: Entry[], base: string): ResolvedEntry[] {
  let names: string[] | null = null;
  const out: ResolvedEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if ('name' in e) {
      out.push(e);
      continue;
    }
    if (!names) {
      try { names = fs.readdirSync(base); } catch { names = []; }
    }
    for (const name of names) {
      if (e.match.test(name) && !seen.has(name)) {
        seen.add(name);
        out.push({ name, type: e.type, cat: e.cat });
      }
    }
  }
  return out;
}

// Symlink shared session/history/settings state from the provider's system home
// into an isolated profile (or cross-provider agent) home. `categories` limits which
// categories are shared: undefined => safe defaults, [] => none (fully isolated). Best-effort:
// any failure is ignored so an odd/missing default home never blocks execution.
export function linkSharedState(
  provider: string,
  home: string,
  opts: { isCross?: boolean; categories?: readonly string[] } = {},
): void {
  const base = defaultHomeFor(provider);
  if (!base) return;
  if (path.resolve(base) === path.resolve(home)) return; // never self-link

  const allow = opts.categories === undefined ? defaultShareCategories(provider) : opts.categories;
  for (const { name, type, cat } of resolveEntries(SHARED[providerKey(provider)] || [], base)) {
    if (!allow.includes(cat)) continue;
    if (opts.isCross && INJECTED_WHEN_CROSS.has(name)) continue;
    const target = path.join(base, name);
    const link = path.join(home, name);
    try {
      // Ensure a directory target exists so new history written through the link
      // lands in the shared home. Don't fabricate empty files.
      if (type === 'dir' && !fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
      if (type === 'file' && !fs.existsSync(target)) continue; // nothing to share yet

      let st: fs.Stats | null = null;
      try { st = fs.lstatSync(link); } catch {}
      if (st) {
        if (st.isSymbolicLink()) fs.rmSync(link);
        else continue; // real data already lives here — do not clobber it
      }
      fs.symlinkSync(target, link, type === 'dir' ? 'dir' : 'file');
    } catch {}
  }
}

// Human-readable summary of a profile's `share` value for `list` / `sharing`.
export function describeShare(share: string[] | undefined, provider?: string): string {
  const categories = provider ? supportedShareCategories(provider) : SHARE_CATEGORIES;
  const defaults = defaultShareCategories(provider);
  if (share === undefined) return `shared: ${defaults.join(', ')}`;
  if (share.length === 0) return `isolated: ${categories.join(', ')}`;
  const shared = share.filter((c): c is ShareCategory => categories.includes(c as ShareCategory));
  if (shared.length === 0) return `isolated: ${categories.join(', ')}`;
  const isolated = categories.filter((c) => !shared.includes(c));
  return `shared: ${shared.join(', ')}${isolated.length ? ` (isolated: ${isolated.join(', ')})` : ''}`;
}
