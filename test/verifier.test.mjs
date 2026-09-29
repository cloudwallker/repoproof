import test from 'node:test';
import assert from 'node:assert/strict';
import { access, symlink, rmdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepo } from './helpers.mjs';
import { captureSnapshot } from '../src/snapshot.ts';
import { receiptDigest, snapshotDigest } from '../src/integrity.ts';

const { validateReceipt, verifyReceipt } = await import('../src/verifier.ts').catch(() => ({}));
const UUID = 'd3218e65-51d2-4b36-89c6-2e8ddc55e189';
const sign = (receipt) => { receipt.integrity = { algorithm: 'sha256', digest: receiptDigest(receipt) }; return receipt; };
const resignSnapshot = (snapshot) => { snapshot.digest = snapshotDigest(snapshot); };
async function fixture(include = []) {
  const repo = await createRepo({ 'a.txt': 'original', 'b.txt': 'remove', '.gitignore': '*.secret\n' });
  repo.git(['add', '--all']); repo.git(['commit', '-q', '-m', 'fixture']);
  const before = await captureSnapshot(repo.dir, include);
  const receipt = sign({ schemaVersion: 1, id: UUID, checkId: 'tests',
    startedAt: '2026-09-29T10:00:00.000Z', finishedAt: '2026-09-29T10:00:00.100Z', durationMs: 100,
    command: ['node', '--test'], environment: { node: 'v24.14.0', platform: 'win32' },
    execution: { status: 'passed', exitCode: 0, signal: null, reason: null },
    before, after: structuredClone(before), output: { stdout: '', stderr: '', truncated: false } });
  return { repo, receipt };
}

test('valid receipt retains original execution and unchanged freshness', async () => {
  assert.equal(typeof validateReceipt, 'function'); assert.equal(typeof verifyReceipt, 'function');
  const { repo, receipt } = await fixture();
  assert.equal(validateReceipt(receipt).id, UUID);
  const result = await verifyReceipt(receipt, repo.dir);
  assert.equal(result.execution, 'passed'); assert.equal(result.freshness, 'unchanged');
  assert.deepEqual(result.changes, []);
});

test('same HEAD changes report modified and deleted paths while retaining historical failure', async () => {
  assert.equal(typeof verifyReceipt, 'function');
  const { repo, receipt } = await fixture();
  receipt.execution = { status: 'failed', exitCode: 7, signal: null, reason: null }; sign(receipt);
  await repo.write('a.txt', 'modified'); await repo.remove('b.txt');
  const result = await verifyReceipt(receipt, repo.dir);
  assert.equal(result.execution, 'failed'); assert.equal(result.freshness, 'changed');
  assert.deepEqual(result.changes, [{ path: 'a.txt', kind: 'modified' }, { path: 'b.txt', kind: 'deleted' }]);
});

test('included untracked directory additions stale receipts but ignores and receipt files do not', async () => {
  assert.equal(typeof verifyReceipt, 'function');
  const { repo, receipt } = await fixture(['new']);
  await repo.write('outside.txt', 'excluded'); await repo.write('new/hidden.secret', 'ignored');
  await repo.write('.repoproof/receipts/nested.json', 'receipt');
  assert.equal((await verifyReceipt(receipt, repo.dir)).freshness, 'unchanged');
  await repo.write('new/文 件.txt', 'included');
  const result = await verifyReceipt(receipt, repo.dir);
  assert.equal(result.freshness, 'changed');
  assert.deepEqual(result.changes, [{ path: 'new/文 件.txt', kind: 'added' }]);
});

test('restoring an already missing tracked file is added and new HEAD is separately visible', async () => {
  assert.equal(typeof verifyReceipt, 'function');
  const { repo, receipt } = await fixture();
  await repo.remove('a.txt'); receipt.before = await captureSnapshot(repo.dir);
  receipt.after = structuredClone(receipt.before); sign(receipt);
  await repo.write('a.txt', 'restored');
  assert.deepEqual((await verifyReceipt(receipt, repo.dir)).changes, [{ path: 'a.txt', kind: 'added' }]);
  repo.git(['add', '--all']); repo.git(['commit', '-q', '-m', 'second']);
  assert.ok((await verifyReceipt(receipt, repo.dir)).changes.some((change) => change.path === 'HEAD' && change.kind === 'head_changed'));
});

test('a removed included untracked file is deleted even when absent from current enumeration', async () => {
  assert.equal(typeof verifyReceipt, 'function');
  const { repo, receipt } = await fixture(['new']);
  await repo.write('new/a.txt', 'a'); receipt.before = await captureSnapshot(repo.dir, ['new']);
  receipt.after = structuredClone(receipt.before); sign(receipt); await repo.remove('new/a.txt');
  assert.deepEqual((await verifyReceipt(receipt, repo.dir)).changes, [{ path: 'new/a.txt', kind: 'deleted' }]);
});

test('a file becoming a symlink is reported as a type change without reading its target', async (t) => {
  assert.equal(typeof verifyReceipt, 'function');
  const { repo, receipt } = await fixture(); await repo.remove('a.txt');
  try { await symlink('b.txt', join(repo.dir, 'a.txt'), 'file'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Windows file symlink privilege unavailable'); throw error; }
  assert.deepEqual((await verifyReceipt(receipt, repo.dir)).changes, [{ path: 'a.txt', kind: 'type_changed' }]);
});

test('missing after and before/after modifications are unverifiable without filesystem access', async () => {
  assert.equal(typeof verifyReceipt, 'function');
  const { receipt } = await fixture();
  receipt.after = null; sign(receipt);
  assert.equal((await verifyReceipt(receipt, 'Z:/does-not-exist')).freshness, 'unverifiable');
  receipt.after = structuredClone(receipt.before); receipt.after.files[0].sha256 = 'a'.repeat(64);
  resignSnapshot(receipt.after); sign(receipt);
  const result = await verifyReceipt(receipt, 'Z:/does-not-exist');
  assert.equal(result.freshness, 'unverifiable'); assert.ok(result.reasons.length);
});

test('submodule and unreadable null hashes with matching issues are legal but unverifiable', async () => {
  assert.equal(typeof validateReceipt, 'function');
  const { repo, receipt } = await fixture();
  repo.git(['update-index', '--add', '--cacheinfo', `160000,${receipt.before.head},module`]);
  receipt.before = await captureSnapshot(repo.dir); receipt.after = structuredClone(receipt.before); sign(receipt);
  assert.doesNotThrow(() => validateReceipt(receipt));
  assert.equal((await verifyReceipt(receipt, repo.dir)).freshness, 'unverifiable');
  for (const snapshot of [receipt.before, receipt.after]) {
    snapshot.files[0].sha256 = null;
    snapshot.issues.push({ path: snapshot.files[0].path, code: 'unreadable_file', message: 'Cannot read.' }); resignSnapshot(snapshot);
  }
  sign(receipt); assert.doesNotThrow(() => validateReceipt(receipt));
  assert.equal((await verifyReceipt(receipt, repo.dir)).freshness, 'unverifiable');
});

test('current unsafe parent junction produces unverifiable instead of unchanged or leaked private paths', async () => {
  assert.equal(typeof verifyReceipt, 'function');
  const { repo, receipt } = await fixture(['dir']); await repo.write('dir/a.txt', 'original'); repo.git(['add', '--all']);
  receipt.before = await captureSnapshot(repo.dir, ['dir']); receipt.after = structuredClone(receipt.before); sign(receipt);
  await repo.remove('dir/a.txt'); await rmdir(join(repo.dir, 'dir'));
  const outside = await mkdtemp(join(tmpdir(), 'repoproof-verifier-outside-')); await writeFile(join(outside, 'a.txt'), 'private');
  await symlink(outside, join(repo.dir, 'dir'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await verifyReceipt(receipt, repo.dir); assert.equal(result.freshness, 'unverifiable');
  assert.ok(!JSON.stringify(result).includes(outside));
});

test('verification never executes receipt command, even when it can create a marker', async () => {
  assert.equal(typeof verifyReceipt, 'function');
  const { repo, receipt } = await fixture();
  receipt.command = [process.execPath, '-e', "require('node:fs').writeFileSync('marker.txt','executed')"]; sign(receipt);
  assert.equal((await verifyReceipt(receipt, repo.dir)).freshness, 'unchanged');
  await assert.rejects(access(join(repo.dir, 'marker.txt')), { code: 'ENOENT' });
});

test('invalid structure, semantics and digests are rejected before access with safe IDs retained', async () => {
  assert.equal(typeof validateReceipt, 'function'); assert.equal(typeof verifyReceipt, 'function');
  const { receipt } = await fixture();
  const mutations = [
    (r) => { r.schemaVersion = 2; }, (r) => { r.id = 'invalid'; },
    (r) => { r.checkId = '../private'; }, (r) => { r.finishedAt = '2026-09-28T10:00:00.000Z'; },
    (r) => { r.startedAt = '2026-02-30T00:00:00.000Z'; }, (r) => { r.durationMs = Infinity; },
    (r) => { r.command = []; }, (r) => { r.command = ['']; }, (r) => { r.command = ['node', 'x'.repeat(65537)]; },
    (r) => { r.command = Array(1025).fill('node'); }, (r) => { r.environment.node = ''; },
    (r) => { r.output.stdout = 'x'.repeat(262145); }, (r) => { r.output.truncated = 'yes'; },
    (r) => { r.execution.exitCode = 1; }, (r) => { r.execution.signal = 'SIGTERM'; },
    (r) => { r.execution.status = 'failed'; }, (r) => { r.execution.status = 'incomplete'; r.execution.reason = 'arbitrary'; },
    (r) => { r.before.files.push(structuredClone(r.before.files[0])); },
    (r) => { r.before.files[0].sha256 = null; }, (r) => { r.before.files[0].sha256 = 'abc'; },
    (r) => { r.before.files[0].kind = 'missing'; }, (r) => { r.before.head = 'not-head'; },
    (r) => { r.before.untrackedExcluded = -1; }, (r) => { r.before.capturedAt = 'today'; },
    (r) => { r.before.scope.exclude = []; }, (r) => { r.before.scope.includeUntracked = ['new', 'new']; },
    (r) => { r.after.scope.includeUntracked = ['new']; },
    (r) => { r.before.issues = [{ path: 'absent.txt', code: 'unreadable_file', message: 'problem' }]; },
    (r) => { r.extra = 'unsupported'; },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(receipt); mutate(bad);
    // Re-sign valid JSON so shape validation cannot be replaced by checking the outer hash.
    try { resignSnapshot(bad.before); if (bad.after) resignSnapshot(bad.after); sign(bad); } catch {}
    assert.throws(() => validateReceipt(bad), /receipt|snapshot|invalid|Invalid|收据/);
    const result = await verifyReceipt(bad, 'Z:/does-not-exist');
    assert.equal(result.freshness, 'invalid'); assert.equal(result.execution, 'unknown');
    assert.ok(!JSON.stringify(result).includes('../private'));
  }
  for (const path of ['../a', 'a/../b', '/absolute', 'a\0b', '.git/config', '.repoproof/x', 'a/./b', 'a//b', 'a/']) {
    const bad = structuredClone(receipt); bad.before.files[0].path = path; resignSnapshot(bad.before); sign(bad);
    assert.throws(() => validateReceipt(bad)); assert.equal((await verifyReceipt(bad, 'Z:/none')).freshness, 'invalid');
    const scoped = structuredClone(receipt); scoped.before.scope.includeUntracked = [path]; resignSnapshot(scoped.before); sign(scoped);
    assert.throws(() => validateReceipt(scoped));
  }
  const badDigest = structuredClone(receipt); badDigest.output.stdout = 'tampered';
  assert.equal((await verifyReceipt(badDigest, 'Z:/none')).checkId, 'tests');
  assert.equal((await verifyReceipt(badDigest, 'Z:/none')).receiptId, UUID);
  assert.equal((await verifyReceipt(badDigest, 'Z:/none')).freshness, 'invalid');
  const badSnapshot = structuredClone(receipt); badSnapshot.before.digest = 'f'.repeat(64); sign(badSnapshot);
  assert.throws(() => validateReceipt(badSnapshot));
});

test('non-JSON objects, accessors, malformed primitives and cyclic values cannot escape validation', async () => {
  assert.equal(typeof verifyReceipt, 'function');
  let invoked = false;
  const accessor = {}; Object.defineProperty(accessor, 'schemaVersion', { enumerable: true, get() { invoked = true; return 1; } });
  const cyclic = {}; cyclic.self = cyclic;
  for (const input of [null, [], 'broken-json', 1, accessor, cyclic, new Date()]) {
    assert.equal((await verifyReceipt(input, 'Z:/none')).freshness, 'invalid');
  }
  assert.equal(invoked, false);
});

test('valid incomplete states and root include remain accepted, snapshot capture failure is private', async () => {
  assert.equal(typeof validateReceipt, 'function');
  const { receipt } = await fixture(['.']);
  for (const execution of [
    { status: 'incomplete', exitCode: null, signal: null, reason: 'spawn_error' },
    { status: 'incomplete', exitCode: null, signal: 'SIGTERM', reason: 'timeout' },
    { status: 'incomplete', exitCode: 1, signal: null, reason: 'interrupted' },
  ]) {
    receipt.execution = execution; sign(receipt); assert.doesNotThrow(() => validateReceipt(receipt));
  }
  const result = await verifyReceipt(receipt, 'Z:/private-personal-path/none');
  assert.equal(result.execution, 'incomplete'); assert.equal(result.freshness, 'unverifiable');
  assert.ok(!JSON.stringify(result).includes('private-personal-path'));
});

test('removing an already missing fingerprint from the Git index still changes snapshot freshness', async () => {
  const { repo, receipt } = await fixture();
  await repo.remove('a.txt'); receipt.before = await captureSnapshot(repo.dir);
  receipt.after = structuredClone(receipt.before); sign(receipt);
  repo.git(['rm', '--cached', 'a.txt']);
  const result = await verifyReceipt(receipt, repo.dir);
  assert.equal(result.freshness, 'changed');
  assert.deepEqual(result.changes, [{ path: 'a.txt', kind: 'deleted' }]);
});

test('tracked nested receipt-like directories contain ordinary files that can be verified', async () => {
  const { repo, receipt } = await fixture();
  await repo.write('fixtures/.repoproof/sample.txt', 'sample'); repo.git(['add', '--all']);
  receipt.before = await captureSnapshot(repo.dir); receipt.after = structuredClone(receipt.before); sign(receipt);
  assert.doesNotThrow(() => validateReceipt(receipt));
  assert.equal((await verifyReceipt(receipt, repo.dir)).freshness, 'unchanged');
  await repo.write('fixtures/.repoproof/sample.txt', 'modified');
  assert.deepEqual((await verifyReceipt(receipt, repo.dir)).changes, [{ path: 'fixtures/.repoproof/sample.txt', kind: 'modified' }]);
});

test('nested receipt-like include scopes are valid while dangerous includes remain invalid', async () => {
  const { receipt } = await fixture();
  for (const snapshot of [receipt.before, receipt.after]) {
    snapshot.scope.includeUntracked = ['fixtures/.repoproof']; resignSnapshot(snapshot);
  }
  sign(receipt); assert.doesNotThrow(() => validateReceipt(receipt));
  for (const include of ['.repoproof', '.repoproof/receipts', 'fixtures/.git', 'fixtures/C:name', 'fixtures/back\\name', '/absolute']) {
    const bad = structuredClone(receipt);
    for (const snapshot of [bad.before, bad.after]) { snapshot.scope.includeUntracked = [include]; resignSnapshot(snapshot); }
    sign(bad); assert.throws(() => validateReceipt(bad));
  }
});

test('POSIX fingerprint names are schema-valid and cannot be misinterpreted during Windows verification', async () => {
  const { receipt } = await fixture();
  for (const path of ['colon:name.txt', 'back\\name.txt', '   ']) {
    const candidate = structuredClone(receipt);
    for (const snapshot of [candidate.before, candidate.after]) {
      snapshot.files[0].path = path;
      snapshot.issues = [{ path, code: 'unreadable_file', message: 'Unreadable.' }]; resignSnapshot(snapshot);
    }
    sign(candidate); assert.doesNotThrow(() => validateReceipt(candidate));
    // Remove issues to exercise Windows's unsupported-name guard before any current capture.
    for (const snapshot of [candidate.before, candidate.after]) { snapshot.issues = []; resignSnapshot(snapshot); }
    sign(candidate); assert.doesNotThrow(() => validateReceipt(candidate));
    if (process.platform === 'win32' && path.trim()) {
      const result = await verifyReceipt(candidate, 'Z:/unavailable-private-repo');
      assert.equal(result.freshness, 'unverifiable');
      assert.match(result.reasons.join(' '), /POSIX.*Windows|Windows.*POSIX/);
      assert.ok(!JSON.stringify(result).includes('unavailable-private-repo'));
    }
  }
});

test('POSIX Git names containing colon or backslash report real content changes', { skip: process.platform === 'win32' ? 'Windows cannot create these POSIX filenames; no POSIX execution claimed' : false }, async () => {
  const { repo, receipt } = await fixture();
  await repo.write('colon:name.txt', 'one'); await repo.write('back\\name.txt', 'two'); await repo.write('   ', 'space');
  repo.git(['add', '--all']); receipt.before = await captureSnapshot(repo.dir); receipt.after = structuredClone(receipt.before); sign(receipt);
  assert.equal((await verifyReceipt(receipt, repo.dir)).freshness, 'unchanged');
  await repo.write('colon:name.txt', 'modified'); await repo.write('back\\name.txt', 'modified');
  assert.deepEqual((await verifyReceipt(receipt, repo.dir)).changes, [{ path: 'back\\name.txt', kind: 'modified' }, { path: 'colon:name.txt', kind: 'modified' }]);
});
