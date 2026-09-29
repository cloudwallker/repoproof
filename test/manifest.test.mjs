import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const module = await import('../src/manifest.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
function api(name) {
  assert.equal(typeof module[name], 'function', `${name} must implement the manifest contract`);
  return module[name];
}
const manifest = () => ({ schemaVersion: 1, goal: '完成项目', checks: [{ id: 'test', title: '测试' }], tasks: [{ id: 'ship', title: '交付', status: 'done', checks: ['test'], note: '自述' }] });

test('manifest accepts declared data and empty lists without executing fields', () => {
  assert.deepEqual(api('validateManifest')(manifest()), manifest());
  assert.deepEqual(api('validateManifest')({ schemaVersion: 1, goal: '开始', checks: [], tasks: [] }), { schemaVersion: 1, goal: '开始', checks: [], tasks: [] });
});

test('manifest rejects duplicate ids and duplicate or nonexistent references', () => {
  const validate = api('validateManifest');
  for (const mutate of [
    value => value.checks.push({ id: 'test', title: 'duplicate' }),
    value => value.tasks.push({ ...value.tasks[0] }),
    value => value.tasks[0].checks.push('test'),
    value => value.tasks[0].checks.push('missing'),
  ]) {
    const value = manifest(); mutate(value); assert.throws(() => validate(value));
  }
});

test('manifest rejects wrong versions, enums, fields, arrays and unsafe ids', () => {
  const validate = api('validateManifest');
  for (const mutate of [
    value => value.schemaVersion = 2,
    value => value.tasks[0].status = 'verified',
    value => value.checks = {},
    value => value.tasks[0].checks = 'test',
    value => value.checks[0].title = ' ',
    value => value.checks[0].id = '../test',
    value => value.tasks[0].note = 12,
    value => value.command = 'run me',
    value => value.tasks[0].extra = true,
    value => value.goal = 'x'.repeat(10001),
    value => value.tasks = Array.from({ length: 1001 }, (_, i) => ({ id: `a${i}`, title: 'x', status: 'todo', checks: [] })),
  ]) {
    const value = manifest(); mutate(value); assert.throws(() => validate(value));
  }
  for (const value of [null, [], 4, 'x']) assert.throws(() => validate(value));
});

test('loadManifest parses real JSON and rejects malformed or oversized files', async () => {
  const load = api('loadManifest');
  const dir = await mkdtemp(join(tmpdir(), 'repoproof-manifest-'));
  try {
    const path = join(dir, 'task.json');
    await writeFile(path, JSON.stringify(manifest()));
    assert.deepEqual(await load(path), manifest());
    await writeFile(path, '{bad json'); await assert.rejects(load(path));
    await writeFile(path, ' '.repeat(1024 * 1024 + 1)); await assert.rejects(load(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('manifest rejects sparse lists and inherited or accessor fields without invoking them', () => {
  const validate = api('validateManifest');
  const sparse = manifest(); sparse.checks = new Array(1);
  assert.throws(() => validate(sparse));
  let accessed = false;
  const inherited = Object.create({ get goal() { accessed = true; return 'inherited'; } });
  Object.assign(inherited, { schemaVersion: 1, checks: [], tasks: [] });
  assert.throws(() => validate(inherited));
  assert.equal(accessed, false);
  const accessor = manifest(); Object.defineProperty(accessor, 'goal', { get() { accessed = true; return 'getter'; } });
  assert.throws(() => validate(accessor));
  assert.equal(accessed, false);
});

for (const field of ['checks', 'tasks', 'references']) {
  test(`manifest rejects ${field} array getters without invoking them`, () => {
    const value = manifest();
    const array = field === 'references' ? value.tasks[0].checks : value[field];
    const original = array[0];
    let accesses = 0;
    Object.defineProperty(array, '0', { enumerable: true, get() { accesses++; return original; } });
    let rejected = false;
    try { api('validateManifest')(value); } catch { rejected = true; }
    assert.equal(accesses, 0, 'array getters must never execute');
    assert.equal(rejected, true);
  });
}

test('manifest rejects custom array iterators without executing them', () => {
  const value = manifest();
  let iterations = 0;
  value.checks[Symbol.iterator] = function* () { iterations++; yield { id: 'test', title: '测试' }; };
  let rejected = false;
  try { api('validateManifest')(value); } catch { rejected = true; }
  assert.equal(iterations, 0, 'custom array iterators must never execute');
  assert.equal(rejected, true);
});

test('manifest accepts only dense ordinary arrays with enumerable data indices and no extra keys', () => {
  for (const mutate of [
    array => array.extra = true,
    array => array[Symbol('extra')] = true,
    array => Object.defineProperty(array, '0', { value: array[0], enumerable: false }),
    array => Object.setPrototypeOf(array, Object.create(Array.prototype)),
  ]) {
    const value = manifest(); mutate(value.checks);
    assert.throws(() => api('validateManifest')(value));
  }
  const value = manifest(); value.tasks = new Array(1);
  assert.throws(() => api('validateManifest')(value));
});
