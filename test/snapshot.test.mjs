import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createRepo } from './helpers.mjs';

const { captureSnapshot, resolveRepoRoot } = await import('../src/snapshot.ts').catch(() => ({}));
const hash = (text) => createHash('sha256').update(text).digest('hex');
const track = (repo) => repo.git(['add', '--all']);

test('repository resolution normalizes subdirectories and rejects non-Git directories', async () => {
  assert.equal(typeof resolveRepoRoot, 'function');
  const repo = await createRepo({ 'nested/a.txt': 'a' });
  assert.equal(resolveRepoRoot(join(repo.dir, 'nested')), repo.dir);
  const nonRepo = await mkdtemp(join(tmpdir(), 'repoproof-tests-empty-'));
  assert.throws(() => resolveRepoRoot(nonRepo), /Git|repository/i);
});

test('repository fixtures normalize an aliased temporary directory', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'repoproof-tests-alias-')));
  const actual = join(base, 'actual');
  const alias = join(base, 'alias');
  await mkdir(actual);
  await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const names = ['TEMP', 'TMP', 'TMPDIR'];
  const previous = names.map(name => process.env[name]);
  let repo;
  try {
    for (const name of names) process.env[name] = alias;
    repo = await createRepo({ 'a.txt': 'a' });
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
  assert.equal(repo.dir, await realpath(repo.dir));
  assert.equal(resolveRepoRoot(repo.dir), repo.dir);
});
test('NUL-delimited Git paths preserve Unicode, spaces, and distinct filenames', async () => {
  assert.equal(typeof captureSnapshot, 'function');
  const files = { '文 档.txt': '中文', 'space name.txt': 'space', 'plain.txt': 'plain' };
  if (process.platform !== 'win32') files['line\nbreak.txt'] = 'newline';
  const repo = await createRepo(files); track(repo);
  const snapshot = await captureSnapshot(repo.dir);
  assert.equal(snapshot.head, null);
  assert.deepEqual(snapshot.files.map((f) => f.path), Object.keys(files).sort());
  for (const file of snapshot.files) assert.equal(file.sha256, hash(files[file.path]));
  assert.deepEqual(snapshot.issues, []);
});
test('tracked content changes at identical HEAD and deleted files remain visible', async () => {
  assert.equal(typeof captureSnapshot, 'function');
  const repo = await createRepo({ 'a.txt': 'before', 'b.txt': 'delete' }); track(repo);
  repo.git(['commit', '-q', '-m', 'fixture']);
  const before = await captureSnapshot(repo.dir);
  await repo.write('a.txt', 'after'); await repo.remove('b.txt');
  const after = await captureSnapshot(repo.dir);
  assert.equal(after.head, before.head);
  assert.notEqual(after.digest, before.digest);
  assert.deepEqual(after.files, [{ path: 'a.txt', kind: 'file', sha256: hash('after') }, { path: 'b.txt', kind: 'missing', sha256: null }]);
});
test('include files and directories obey ignores and exclude receipts including tracked receipts', async () => {
  assert.equal(typeof captureSnapshot, 'function');
  const repo = await createRepo({ '.gitignore': '*.secret\nignored/\n', 'tracked.txt': 'a', '.repoproof/receipts/old.json': 'old' }); track(repo);
  await repo.write('new/file.txt', 'new'); await repo.write('new/private.secret', 'hidden');
  await repo.write('ignored/file.txt', 'ignored'); await repo.write('outside.txt', 'outside');
  await repo.write('.repoproof/receipts/new.json', 'receipt');
  const plain = await captureSnapshot(repo.dir);
  assert.equal(plain.untrackedExcluded, 2);
  assert.deepEqual(plain.files.map((f) => f.path), ['.gitignore', 'tracked.txt']);
  const included = await captureSnapshot(repo.dir, ['new', 'outside.txt', 'new']);
  assert.deepEqual(included.scope, { includeUntracked: ['new', 'outside.txt'], exclude: ['.repoproof/'] });
  assert.equal(included.untrackedExcluded, 0);
  assert.deepEqual(included.files.map((f) => f.path), ['.gitignore', 'new/file.txt', 'outside.txt', 'tracked.txt']);
  assert.deepEqual((await captureSnapshot(repo.dir, ['ignored', 'new/private.secret'])).files.map((f) => f.path), ['.gitignore', 'tracked.txt']);
});
test('unsafe include paths cannot escape or inspect Git and receipt internals', async () => {
  assert.equal(typeof captureSnapshot, 'function');
  const repo = await createRepo();
  for (const path of ['../outside', 'a/../b', '/absolute', 'C:/outside', 'C:relative', '\\outside', 'a\\..\\outside', '.git', '.git/config', '.repoproof', '.repoproof/receipts', 'a\u0000b', '']) {
    await assert.rejects(captureSnapshot(repo.dir, [path]), /include|path|relative/i);
  }
});

test('nested ordinary receipt-named directories remain in tracked and explicit untracked scope', async () => {
  const repo = await createRepo({ 'fixtures/.repoproof/tracked.txt': 'tracked example', '.repoproof/ignored.txt': 'local receipt' });
  track(repo);
  await repo.write('fixtures/.repoproof/new.txt', 'new example');
  const snapshot = await captureSnapshot(repo.dir, ['fixtures/.repoproof']);
  assert.deepEqual(snapshot.files.map(file => file.path), ['fixtures/.repoproof/new.txt', 'fixtures/.repoproof/tracked.txt']);
  assert.deepEqual(snapshot.scope.includeUntracked, ['fixtures/.repoproof']);
  for (const unsafe of ['./.repoproof', 'fixtures/.git']) {
    await assert.rejects(captureSnapshot(repo.dir, [unsafe]));
  }
});
test('parent directory junctions cannot cause reads outside the repository', async () => {
  assert.equal(typeof captureSnapshot, 'function');
  const repo = await createRepo({ 'dir/a.txt': 'original' }); track(repo);
  await repo.remove('dir/a.txt');
  const outside = await mkdtemp(join(tmpdir(), 'repoproof-tests-outside-'));
  await writeFile(join(outside, 'a.txt'), 'outside private content');
  // The empty directory is replaced in this isolated fixture only.
  const { rmdir } = await import('node:fs/promises'); await rmdir(join(repo.dir, 'dir'));
  await symlink(outside, join(repo.dir, 'dir'), process.platform === 'win32' ? 'junction' : 'dir');
  const snapshot = await captureSnapshot(repo.dir);
  assert.ok(snapshot.issues.some((issue) => issue.path === 'dir/a.txt'));
  assert.equal(snapshot.files[0].sha256, null);
});
test('symlinks hash target text without reading external content', async (t) => {
  assert.equal(typeof captureSnapshot, 'function');
  const repo = await createRepo();
  const outside = await mkdtemp(join(tmpdir(), 'repoproof-tests-link-'));
  const target = join(outside, 'secret.txt'); await writeFile(target, 'private');
  try { await symlink(target, join(repo.dir, 'link.txt'), 'file'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Windows file symlink privilege unavailable'); throw error; }
  track(repo);
  const before = await captureSnapshot(repo.dir);
  assert.deepEqual(before.files, [{ path: 'link.txt', kind: 'symlink', sha256: hash(target) }]);
  await writeFile(target, 'changed private');
  assert.equal((await captureSnapshot(repo.dir)).digest, before.digest);
});
test('submodule Git index entries produce unsupported issues', async () => {
  assert.equal(typeof captureSnapshot, 'function');
  const repo = await createRepo({ 'a.txt': 'a' }); track(repo); repo.git(['commit', '-q', '-m', 'fixture']);
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  repo.git(['update-index', '--add', '--cacheinfo', `160000,${head},module`]);
  const snapshot = await captureSnapshot(repo.dir);
  assert.deepEqual(snapshot.files.find((f) => f.path === 'module'), { path: 'module', kind: 'submodule', sha256: null });
  assert.ok(snapshot.issues.some((i) => i.code === 'unsupported_submodule' && i.path === 'module'));
});
test('unreadable tracked file representations yield issues instead of fresh-looking fingerprints', async () => {
  assert.equal(typeof captureSnapshot, 'function');
  const repo = await createRepo({ 'a.txt': 'a' }); track(repo);
  await repo.remove('a.txt'); await mkdir(join(repo.dir, 'a.txt'));
  const snapshot = await captureSnapshot(repo.dir);
  assert.ok(snapshot.issues.some((issue) => issue.path === 'a.txt'));
  assert.equal(snapshot.files[0].sha256, null);
});
test('repository snapshots ignore inherited Git repository overrides', async () => {
  const repo = await createRepo({ 'local.txt': 'local' }); track(repo);
  const other = await createRepo({ 'external.txt': 'external' }); track(other);
  const prior = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(other.dir, '.git');
    assert.equal(resolveRepoRoot(repo.dir), repo.dir);
    assert.deepEqual((await captureSnapshot(repo.dir)).files.map((f) => f.path), ['local.txt']);
  } finally { if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior; }
});
test('a dot-prefixed directory is not mistaken for parent traversal', async () => {
  const repo = await createRepo({ '..data/a.txt': 'allowed' }); track(repo);
  const snapshot = await captureSnapshot(repo.dir);
  assert.deepEqual(snapshot.issues, []);
  assert.deepEqual(snapshot.files, [{ path: '..data/a.txt', kind: 'file', sha256: hash('allowed') }]);
});

for (const kind of ['file', 'symlink']) {
  test(`a ${kind} disappearing after initial lstat reports concurrent_change`, async (t) => {
    const repo = await createRepo(kind === 'file' ? { 'race.txt': 'initial' } : { 'target.txt': 'target' });
    if (kind === 'symlink') {
      try { await symlink('target.txt', join(repo.dir, 'race.txt'), 'file'); }
      catch (error) { if (error.code === 'EPERM') return t.skip('Windows file symlink privilege unavailable'); throw error; }
    }
    track(repo);
    const method = kind === 'file' ? 'open' : 'readlink';
    const original = fsPromises[method];
    const path = join(repo.dir, 'race.txt');
    // Delete a real fixture file at the exact race boundary, then let the real
    // filesystem operation fail. Assertions examine captureSnapshot output.
    fsPromises[method] = async (candidate, ...args) => {
      if (candidate === path) await fsPromises.unlink(path);
      return original(candidate, ...args);
    };
    syncBuiltinESMExports();
    try {
      const snapshot = await captureSnapshot(repo.dir);
      assert.equal(snapshot.files.find((file) => file.path === 'race.txt').sha256, null);
      assert.ok(snapshot.issues.some((issue) => issue.path === 'race.txt' && issue.code === 'concurrent_change'));
    } finally { fsPromises[method] = original; syncBuiltinESMExports(); }
    const deleted = await captureSnapshot(repo.dir);
    assert.deepEqual(deleted.files.find((file) => file.path === 'race.txt'), { path: 'race.txt', kind: 'missing', sha256: null });
    assert.deepEqual(deleted.issues, []);
  });
}
