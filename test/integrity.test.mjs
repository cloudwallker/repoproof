import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const api = await import('../src/integrity.ts').catch(() => ({}));
const { canonicalJson, sha256, snapshotDigest, receiptDigest } = api;
const snapshot = {
  schemaVersion: 1, head: null, capturedAt: '2026-01-01T00:00:00.000Z',
  scope: { includeUntracked: ['z', 'a'], exclude: ['.repoproof/'] },
  files: [{ path: 'z', kind: 'missing', sha256: null }, { path: 'a', kind: 'file', sha256: 'a'.repeat(64) }],
  issues: [], untrackedExcluded: 0,
};

test('canonical JSON sorts keys recursively and preserves array order', () => {
  assert.equal(typeof canonicalJson, 'function', 'canonicalJson is implemented');
  assert.equal(canonicalJson({ z: [{ b: 1, a: 2 }, 3], a: null }), '{"a":null,"z":[{"a":2,"b":1},3]}');
  assert.equal(canonicalJson({ 2: 'two', 10: 'ten' }), '{"10":"ten","2":"two"}');
  assert.equal(canonicalJson(JSON.parse('{"__proto__":{"z":1,"a":2}}')), '{"__proto__":{"a":2,"z":1}}');
});
test('canonical JSON rejects values JSON cannot faithfully represent', () => {
  assert.equal(typeof canonicalJson, 'function');
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, Symbol('x'), new Date(), new Map(), cyclic, [undefined], [,], { x: undefined }]) {
    assert.throws(() => canonicalJson(value), /JSON|cycle|finite/i);
  }
});
test('canonical JSON rejects array accessors without executing the getter', () => {
  let calls = 0;
  const array = [];
  Object.defineProperty(array, '0', { enumerable: true, get() { calls++; return 1; } });
  assert.throws(() => canonicalJson(array), /JSON|accessor/i);
  assert.equal(calls, 0);
});
test('SHA256 accepts text and bytes with standard known digest', () => {
  assert.equal(typeof sha256, 'function');
  const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(sha256('abc'), expected);
  assert.equal(sha256(new Uint8Array([97, 98, 99])), expected);
});
test('snapshot digest ignores time, issues, counts, and ordering but covers content and scope', () => {
  assert.equal(typeof snapshotDigest, 'function');
  const reordered = { ...snapshot, capturedAt: '2030-01-01', issues: [{ path: 'a', code: 'x', message: 'x' }], untrackedExcluded: 99,
    digest: 'ignored', files: [...snapshot.files].reverse(), scope: { includeUntracked: ['a', 'z'], exclude: ['.repoproof/'] } };
  assert.equal(snapshotDigest(snapshot), snapshotDigest(reordered));
  assert.notEqual(snapshotDigest(snapshot), snapshotDigest({ ...snapshot, head: 'b'.repeat(40) }));
  assert.notEqual(snapshotDigest(snapshot), snapshotDigest({ ...snapshot, files: [{ ...snapshot.files[0], kind: 'file', sha256: 'b'.repeat(64) }] }));
  assert.notEqual(snapshotDigest(snapshot), snapshotDigest({ ...snapshot, scope: { ...snapshot.scope, includeUntracked: ['a'] } }));
});
test('receipt digest excludes its own integrity and covers every other JSON field', () => {
  assert.equal(typeof receiptDigest, 'function');
  const receipt = { schemaVersion: 1, before: snapshot, output: { stdout: 'ok' } };
  assert.equal(receiptDigest(receipt), receiptDigest({ ...receipt, integrity: { algorithm: 'sha256', digest: 'bad' } }));
  assert.notEqual(receiptDigest(receipt), receiptDigest({ ...receipt, output: { stdout: 'changed' } }));
});
test('build erases types and rewrites import paths without changing ordinary strings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repoproof-tests-build-'));
  await mkdir(join(dir, 'scripts'));
  await mkdir(join(dir, 'src'));
  await copyFile(new URL('../scripts/build.mjs', import.meta.url), join(dir, 'scripts/build.mjs')).catch(() => {});
  await writeFile(join(dir, 'src/dep.ts'), 'export const value: number = 7;');
  await writeFile(join(dir, 'src/main.ts'), `import { value } from './dep.ts';\nexport { value } from './dep.ts';\nexport const text: string = "import { value } from './dep.ts'";\nexport const template = \`export * from './dep.ts'\`;\nexport const result = value;\nexport const lazy = () => import('./dep.ts');`);
  assert.doesNotThrow(() => execFileSync(process.execPath, [join(dir, 'scripts/build.mjs')], { cwd: dir, stdio: 'pipe' }));
  const built = await import(`file:///${join(dir, 'dist/main.js').replaceAll('\\', '/')}`);
  assert.equal(built.result, 7);
  assert.equal(built.text, "import { value } from './dep.ts'");
  assert.equal(built.template, "export * from './dep.ts'");
  assert.equal((await built.lazy()).value, 7);
  assert.ok((await readFile(join(dir, 'dist/main.js'), 'utf8')).includes("'./dep.js'"));
});
test('build rewrites dynamic imports inside template expressions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repoproof-tests-build-'));
  await mkdir(join(dir, 'scripts')); await mkdir(join(dir, 'src'));
  await copyFile(new URL('../scripts/build.mjs', import.meta.url), join(dir, 'scripts/build.mjs'));
  await writeFile(join(dir, 'src/dep.ts'), 'export const value: number = 7;');
  await writeFile(join(dir, 'src/main.ts'), 'export const text = `value=${(await import(\'./dep.ts\')).value}`;');
  execFileSync(process.execPath, [join(dir, 'scripts/build.mjs')], { cwd: dir, stdio: 'pipe' });
  const built = await import(`file:///${join(dir, 'dist/main.js').replaceAll('\\', '/')}`);
  assert.equal(built.text, 'value=7');
});
test('bin assigns the main return code and never exposes rejected input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repoproof-tests-bin-'));
  await mkdir(join(dir, 'bin')); await mkdir(join(dir, 'dist'));
  await copyFile(new URL('../bin/repoproof.mjs', import.meta.url), join(dir, 'bin/repoproof.mjs'));
  await writeFile(join(dir, 'dist/cli.js'), 'export async function main(args) { if (args[0] === "fail") throw new Error(args[1]); return Number(args[0]); }');
  let code; try { execFileSync(process.execPath, [join(dir, 'bin/repoproof.mjs'), '1'], { stdio: 'pipe' }); } catch (error) { code = error.status; }
  assert.equal(code, 1);
  try { execFileSync(process.execPath, [join(dir, 'bin/repoproof.mjs'), 'fail', 'synthetic-secret'], { stdio: 'pipe' }); assert.fail('Expected exit code 2'); }
  catch (error) { assert.equal(error.status, 2); assert.doesNotMatch(error.stderr.toString(), /synthetic-secret|Error:| at /); }
});
test('build preserves regular expressions and division before real imports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repoproof-tests-build-'));
  await mkdir(join(dir, 'scripts')); await mkdir(join(dir, 'src'));
  await copyFile(new URL('../scripts/build.mjs', import.meta.url), join(dir, 'scripts/build.mjs'));
  await writeFile(join(dir, 'src/dep.ts'), 'export const value: number = 7;');
  await writeFile(join(dir, 'src/main.ts'), [
    'export const regex = /"/;',
    String.raw`export const characterClass = /[/"']/;`,
    String.raw`export const escaped = /\/"/;`,
    'export function pick() { if (true) /"/.test("quote"); return /"/; }',
    'export const division = 8 / 2;',
    'export const callDivision = (() => 8)() / 2;',
    'export const template = `${/"/.source}:${(await import(\'./dep.ts\')).value}`;',
    "import { value } from './dep.ts';",
    'export const result = value;',
  ].join('\n'));
  execFileSync(process.execPath, [join(dir, 'scripts/build.mjs')], { cwd: dir, stdio: 'pipe' });
  const built = await import(`file:///${join(dir, 'dist/main.js').replaceAll('\\', '/')}`);
  assert.equal(built.result, 7);
  assert.equal(built.regex.source, '"');
  assert.equal(built.characterClass.source, `[/"']`);
  assert.equal(built.escaped.source, String.raw`\/"`);
  assert.equal(built.pick().source, '"');
  assert.equal(built.division, 4);
  assert.equal(built.callDivision, 4);
  assert.equal(built.template, '":7');
});
