import { mkdtemp, writeFile, readFile, mkdir, copyFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, basename, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const project = fileURLToPath(new URL('../', import.meta.url));
const bin = join(project, 'bin', 'repoproof.mjs');
const fixture = await mkdtemp(join(tmpdir(), 'repoproof-demo-'));
const output = resolve(project, 'artifacts', 'demo');
try {
await mkdir(output, { recursive: true });
execFileSync('git', ['init', '-q', fixture], { stdio: 'pipe' });
await writeFile(join(fixture, 'app.mjs'), 'export const answer = 42;\n');
await writeFile(join(fixture, 'app.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import {answer} from './app.mjs';
test('the application returns 42', () => assert.equal(answer, 42));
`);
await writeFile(join(fixture, '.gitignore'), '.repoproof/\n');
execFileSync('git', ['add', 'app.mjs', 'app.test.mjs', '.gitignore'], { cwd: fixture, stdio: 'pipe' });

function run(args, expected) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: fixture, encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== expected) throw new Error(`Demo step ${args[0]} failed (expected ${expected}, got ${result.status}).\n${result.stderr}`);
  return result.stdout;
}

run(['init', '--goal', '演示通过记录如何随着代码变化而过期'], 0);
const manifest = JSON.parse(await readFile(join(fixture, '.repoproof', 'task.json'), 'utf8'));
manifest.tasks[0].status = 'done';
await writeFile(join(fixture, '.repoproof', 'task.json'), JSON.stringify(manifest, null, 2));
const recorded = JSON.parse(run(['run', '--check', 'tests', '--json', '--', process.execPath, '--test', 'app.test.mjs'], 0));
const before = JSON.parse(run(['verify', '--json'], 0));
if (before[0].freshness !== 'unchanged') throw new Error('Demo did not establish matching code state.');
await writeFile(join(output, 'before.json'), JSON.stringify(before, null, 2) + '\n');
await writeFile(join(output, 'handoff-zh-before.md'), run(['brief', '--lang', 'zh'], 0));
await writeFile(join(fixture, 'app.mjs'), 'export const answer = 43;\n');
const after = JSON.parse(run(['verify', '--json'], 1));
if (after[0].execution !== 'passed' || after[0].freshness !== 'changed') throw new Error('Demo confused historical success with current freshness.');
await writeFile(join(output, 'after.json'), JSON.stringify(after, null, 2) + '\n');
await writeFile(join(output, 'handoff-zh-after.md'), run(['brief', '--lang', 'zh'], 1));
await writeFile(join(output, 'handoff-en-after.md'), run(['brief', '--lang', 'en'], 1));
await copyFile(join(fixture, recorded.receiptPath), join(output, 'receipt.json'));
await writeFile(join(output, 'README.md'), `RepoProof demo\n\n1. A real Node test exited 0 and its code snapshot matched.\n2. app.mjs changed from answer=42 to answer=43 without creating a commit.\n3. verify preserved execution=passed and reported freshness=changed.\n4. The handoff brief marked the task as needing a recheck.\n\nThese artifacts contain relative project paths and redacted command metadata.\n`);
process.stdout.write('演示通过：历史执行 passed；修改后快照 changed。\n');
process.stdout.write(`报告：${relative(project, output).replaceAll('\\', '/')}\n`);
} finally {
  const actual = await realpath(fixture);
  const rel = relative(await realpath(tmpdir()), actual);
  if (!isAbsolute(rel) && !rel.startsWith('..' + sep) && !rel.includes(sep) && basename(actual).startsWith('repoproof-demo-')) {
    await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } else throw new Error('Refusing to remove a demo fixture outside the expected temporary directory.');
}
