import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const cliUrl = new URL('../src/cli.ts', import.meta.url).href;
const launcher = 'const {main}=await import(process.argv[1]);process.exitCode=await main(process.argv.slice(2));';
function cli(args, cwd) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', launcher, cliUrl, ...args], {
    cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  });
}
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'repoproof-cli-中文 空格-'));
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' });
  await writeFile(join(dir, 'app.txt'), 'version one\n');
  await writeFile(join(dir, '.gitignore'), '.repoproof/\ncache/\n');
  execFileSync('git', ['add', 'app.txt', '.gitignore'], { cwd: dir, stdio: 'pipe' });
  return dir;
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
function json(result) { assert.equal(result.error, undefined); return JSON.parse(result.stdout); }

test('help and version work without a Git repository', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  for (const name of ['init', 'run', 'verify', 'brief']) assert.match(help.stdout, new RegExp(name));
  const version = cli(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /0\.1\.0/);
});

test('init creates an editable task manifest and never overwrites it', async () => {
  const dir = await repo();
  const first = cli(['init', '--goal', '检查中文项目'], dir);
  assert.equal(first.status, 0, first.stderr);
  const path = join(dir, '.repoproof', 'task.json');
  const original = await readFile(path, 'utf8');
  const manifest = JSON.parse(original);
  assert.equal(manifest.goal, '检查中文项目');
  assert.equal(manifest.checks[0].id, 'tests');
  const again = cli(['init', '--goal', '不能覆盖'], dir);
  assert.equal(again.status, 2);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('brief works before the first check and reports missing evidence', async () => {
  const dir = await repo();
  assert.equal(cli(['init', '--goal', '尚未运行检查'], dir).status, 0);
  const result = cli(['brief', '--json'], dir);
  assert.equal(result.status, 1, result.stderr);
  const data = json(result);
  assert.equal(data.tasks[0].status, 'todo');
  assert.equal(data.checks[0].execution, 'unknown');
  assert.equal(data.checks[0].freshness, 'unverifiable');
});

test('full workflow records success and detects uncommitted changes in the same HEAD', async () => {
  const dir = await repo();
  assert.equal(cli(['init', '--goal', '修复任务'], dir).status, 0);
  const run = cli(['run', '--check', 'tests', '--json', '--', process.execPath, '-e', 'process.stdout.write("checks passed")'], dir);
  assert.equal(run.status, 0, run.stderr);
  const record = json(run);
  assert.equal(record.receipt.execution.status, 'passed');
  const verify = cli(['verify', '--json'], dir);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(json(verify)[0].freshness, 'unchanged');
  await writeFile(join(dir, 'app.txt'), 'version two\n');
  const changed = cli(['verify', '--json'], dir);
  assert.equal(changed.status, 1, changed.stderr);
  const result = json(changed)[0];
  assert.equal(result.execution, 'passed');
  assert.equal(result.freshness, 'changed');
  assert.ok(result.changes.some(c => c.path === 'app.txt' && c.kind === 'modified'));
});

test('brief reports declared done separately and supports Chinese English and JSON', async () => {
  const dir = await repo();
  assert.equal(cli(['init', '--goal', '交接检查'], dir).status, 0);
  assert.equal(cli(['run', '--check', 'tests', '--', process.execPath, '-e', 'process.exit(0)'], dir).status, 0);
  const taskPath = join(dir, '.repoproof', 'task.json');
  const task = JSON.parse(await readFile(taskPath, 'utf8'));
  task.tasks = [
    { id: 'verified', title: '有检查的任务', status: 'done', checks: ['tests'] },
    { id: 'claimed', title: '只有自述', status: 'done', checks: [] },
    { id: 'next', title: '下一步', status: 'todo', checks: [] },
    { id: 'blocked', title: '等待资料', status: 'blocked', checks: [], note: '待输入' },
  ];
  await writeFile(taskPath, JSON.stringify(task));
  const data = json(cli(['brief', '--json'], dir));
  assert.equal(data.tasks[0].status, 'evidenced_done');
  assert.equal(data.tasks[1].status, 'self_reported_done');
  assert.equal(data.tasks[2].status, 'todo');
  assert.equal(data.tasks[3].status, 'blocked');
  const zh = cli(['brief', '--lang', 'zh'], dir);
  assert.equal(zh.status, 0, zh.stderr);
  assert.match(zh.stdout, /自述完成/);
  const en = cli(['brief', '--lang', 'en'], dir);
  assert.equal(en.status, 0, en.stderr);
  assert.match(en.stdout, /self.reported/i);
  const exported = cli(['brief', '--output', '.repoproof/handoff.md'], dir);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(await readFile(join(dir, '.repoproof', 'handoff.md'), 'utf8'), /交接检查/);
});

test('failure timeout and missing program produce incomplete or failed receipts', async () => {
  const dir = await repo();
  for (const [args, status] of [
    [[process.execPath, '-e', 'process.exit(7)'], 'failed'],
    [['repoproof-program-does-not-exist-7d9'], 'incomplete'],
  ]) {
    const result = cli(['run', '--check', 'tests', '--json', '--', ...args], dir);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(json(result).receipt.execution.status, status);
  }
  const timeout = cli(['run', '--check', 'tests', '--timeout', '200', '--json', '--', process.execPath, '-e', 'setTimeout(()=>{},10000)'], dir);
  assert.equal(timeout.status, 1, timeout.stderr);
  assert.equal(json(timeout).receipt.execution.reason, 'timeout');
});

test('cwd supports invoking from a different directory', async () => {
  const dir = await repo();
  const result = cli(['run', '--cwd', dir, '--check', 'tests', '--json', '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(join(dir, '.repoproof', 'receipts'));
  const explicit = cli(['verify', join(dir, '.repoproof', 'receipts', files[0]), '--cwd', dir, '--json']);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(json(explicit)[0].freshness, 'unchanged');
});

test('verify corrupted imported JSON never executes its command', async () => {
  const dir = await repo();
  const marker = join(dir, 'MUST-NOT-EXIST');
  const imported = join(dir, 'untrusted.json');
  await writeFile(imported, JSON.stringify({ command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] }));
  execFileSync('git', ['add', 'untrusted.json'], { cwd: dir, stdio: 'pipe' });
  const result = cli(['verify', imported, '--json'], dir);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(json(result)[0].freshness, 'invalid');
  assert.equal(await exists(marker), false);
  await writeFile(imported, '{broken json');
  const broken = cli(['verify', imported, '--json'], dir);
  assert.equal(broken.status, 2);
  assert.equal(json(broken)[0].freshness, 'invalid');
});

test('usage errors have exit code 2 with actionable diagnostics', async () => {
  for (const args of [['wat'], ['run', '--check', 'tests'], ['run', '--check', 'tests', '--timeout', '-1', '--', 'node'], ['brief', '--lang', 'xx'], ['verify', '--secret-unknown', 'sensitive-value']]) {
    const result = cli(args);
    assert.equal(result.status, 2, `${args[0]}: ${result.stderr}`);
    assert.ok(result.stderr.trim());
    assert.doesNotMatch(result.stderr, /sensitive-value|at main|file:\/\//);
  }
  const dir = await mkdtemp(join(tmpdir(), 'repoproof-no-git-'));
  assert.equal(cli(['init', '--goal', 'goal'], dir).status, 2);
});

test('output cannot target Git internals or escape the project', async () => {
  const dir = await repo();
  cli(['init', '--goal', '输出范围'], dir);
  cli(['run', '--check', 'tests', '--', process.execPath, '-e', 'process.exit(0)'], dir);
  const gitConfig = await readFile(join(dir, '.git', 'config'), 'utf8');
  const denied = cli(['brief', '--output', '.git/config'], dir);
  assert.equal(denied.status, 2);
  assert.equal(await readFile(join(dir, '.git', 'config'), 'utf8'), gitConfig);
  const outside = join(tmpdir(), 'repoproof-outside-' + Date.now() + '.md');
  assert.equal(cli(['brief', '--output', outside], dir).status, 2);
  assert.equal(await exists(outside), false);
});

test('brief export cannot write mixed-case receipt paths or overwrite an existing brief', async () => {
  const dir = await repo();
  assert.equal(cli(['init', '--goal', '保护收据目录'], dir).status, 0);
  const denied = cli(['brief', '--output', '.REPOPROOF/Receipts/handoff.json'], dir);
  assert.equal(denied.status, 2, denied.stderr);
  assert.equal(await exists(join(dir, '.REPOPROOF', 'Receipts', 'handoff.json')), false);
  await writeFile(join(dir, 'handoff.md'), 'existing user text');
  assert.equal(cli(['brief', '--output', 'handoff.md'], dir).status, 2);
  assert.equal(await readFile(join(dir, 'handoff.md'), 'utf8'), 'existing user text');
});
