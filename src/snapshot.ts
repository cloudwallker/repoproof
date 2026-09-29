import { execFileSync } from 'node:child_process';
import { lstat, readlink, realpath, open } from 'node:fs/promises';
import { realpathSync, constants } from 'node:fs';
import { resolve, join, relative, isAbsolute, win32, sep } from 'node:path';
import { sha256, snapshotDigest } from './integrity.ts';
import type { Snapshot, FileFingerprint, SnapshotIssue } from './types.ts';

function git(cwd: string, args: string[]): string {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES']) delete env[key];
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024, env,
  });
}

export function resolveRepoRoot(cwd: string): string {
  try { return realpathSync(resolve(git(cwd, ['rev-parse', '--show-toplevel']).replace(/[\r\n]+$/, ''))); }
  catch { throw new Error('Not a Git repository or Git is unavailable.'); }
}

function normalizeInclude(path: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || path.includes(':') || isAbsolute(path) || win32.isAbsolute(path)) {
    throw new Error('Include path must be a safe relative path.');
  }
  const segments = path.split('/');
  const normalized = segments.filter((part) => part && part !== '.');
  if (segments.some((part) => part === '..' || part.toLowerCase() === '.git') || normalized[0]?.toLowerCase() === '.repoproof') {
    throw new Error('Include path cannot access parent, Git, or receipt directories.');
  }
  return normalized.join('/') || '.';
}

function excluded(path: string): boolean {
  const root = path.split('/')[0].toLowerCase();
  return root === '.repoproof' || root === '.git';
}

async function safeParents(root: string, path: string): Promise<void> {
  const segments = path.split('/');
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    const stat = await lstat(parent);
    if (stat.isSymbolicLink()) throw new Error('unsafe_parent_link');
    if (!stat.isDirectory()) throw new Error('unreadable_parent');
    const actual = await realpath(parent);
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('unsafe_parent_link');
  }
}

export async function captureSnapshot(cwd: string, includeUntracked: string[] = []): Promise<Snapshot> {
  if (!Array.isArray(includeUntracked)) throw new Error('Include paths must be an array.');
  const include = [...new Set(includeUntracked.map(normalizeInclude))].sort();
  const root = resolveRepoRoot(cwd);
  const files: FileFingerprint[] = [];
  const issues: SnapshotIssue[] = [];
  const indexed = new Map<string, string>();
  let untracked: string[];
  let head: string | null = null;
  try { head = git(root, ['rev-parse', '--verify', 'HEAD']).trim(); } catch { /* Unborn branch has no HEAD. */ }
  try {
    for (const entry of git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (tab < 0) throw new Error('Invalid index output.');
      const path = entry.slice(tab + 1);
      if (!excluded(path)) indexed.set(path, entry.slice(0, tab).split(' ')[0]);
    }
    untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter((path) => path && !excluded(path));
  } catch { throw new Error('Unable to enumerate Git repository files.'); }
  let untrackedExcluded = 0;
  for (const path of untracked) {
    if (include.some((scope) => scope === '.' || path === scope || path.startsWith(`${scope}/`))) indexed.set(path, '');
    else untrackedExcluded++;
  }
  for (const [path, mode] of [...indexed].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (mode === '160000') {
      files.push({ path, kind: 'submodule', sha256: null });
      issues.push({ path, code: 'unsupported_submodule', message: 'Submodule contents are not supported in this version.' });
      continue;
    }
    const file: FileFingerprint = { path, kind: 'missing', sha256: null };
    files.push(file);
    let observed = false;
    try {
      await safeParents(root, path);
      const absolute = join(root, path);
      const before = await lstat(absolute, { bigint: true });
      observed = true;
      if (before.isSymbolicLink()) {
        file.kind = 'symlink';
        const target = await readlink(absolute, { encoding: 'buffer' });
        const after = await lstat(absolute, { bigint: true });
        if (before.ino !== after.ino || before.ctimeNs !== after.ctimeNs) throw new Error('concurrent_change');
        file.sha256 = sha256(target);
      } else if (before.isFile()) {
        file.kind = 'file';
        const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          const opened = await handle.stat({ bigint: true });
          if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) throw new Error('concurrent_change');
          const content = await handle.readFile();
          const after = await handle.stat({ bigint: true });
          const current = await lstat(absolute, { bigint: true });
          if (opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs ||
              current.ino !== after.ino || current.dev !== after.dev || current.ctimeNs !== after.ctimeNs || !current.isFile()) {
            throw new Error('concurrent_change');
          }
          await safeParents(root, path);
          file.sha256 = sha256(content);
        } finally { await handle.close(); }
      } else throw new Error('unsupported_file_type');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && !observed) continue;
      file.sha256 = null;
      const known = ['unsafe_parent_link', 'unreadable_parent', 'concurrent_change', 'unsupported_file_type'];
      const reason = code === 'ENOENT' ? 'concurrent_change' :
        known.includes((error as Error).message) ? (error as Error).message : 'unreadable_file';
      issues.push({ path, code: reason, message: 'File could not be safely fingerprinted.' });
    }
  }
  const snapshot: Omit<Snapshot, 'digest'> = {
    schemaVersion: 1, head, capturedAt: new Date().toISOString(),
    scope: { includeUntracked: include, exclude: ['.repoproof/'] }, files, issues, untrackedExcluded,
  };
  return { ...snapshot, digest: snapshotDigest(snapshot) };
}
