import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const project = fileURLToPath(new URL('../', import.meta.url));
const archive = resolve(process.argv[2] ?? join(project, 'artifacts', 'repoproof-0.1.0.tgz'));
const nodeDirectory = dirname(process.execPath);
const npmCli = [process.env.npm_execpath, join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(path => path && existsSync(path));
assert.ok(npmCli, 'Run this smoke check with a Node installation that includes npm.');
assert.ok(existsSync(archive), 'Build the TGZ with npm pack before running the package smoke check.');
const fixture = await mkdtemp(join(tmpdir(), 'repoproof-package-中文 空格-'));
const checks = [];
try {
  const install = spawnSync(process.execPath, [npmCli, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(project, '.npm-cache'), '--prefix', join(fixture, 'tools'), archive], { cwd: fixture, encoding: 'utf8', timeout: 60000 });
  assert.equal(install.error, undefined, 'Offline package installation could not start.');
  assert.equal(install.status, 0, install.stderr);
  checks.push('offline installation without lifecycle scripts');
  const bin = join(fixture, 'tools', 'node_modules', 'repoproof', 'bin', 'repoproof.mjs');
  function run(args, status = 0) {
    const result = spawnSync(process.execPath, [bin, ...args], { cwd: fixture, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined, 'Installed CLI could not start.');
    assert.equal(result.status, status, result.stderr);
    return result.stdout;
  }
  assert.match(run(['--version']), /0\.1\.0/);
  execFileSync('git', ['init', '-q', fixture], { stdio: 'pipe' });
  await writeFile(join(fixture, 'app.mjs'), 'export const answer = 42;\n');
  await writeFile(join(fixture, 'app.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {answer} from './app.mjs';\ntest('answer', () => assert.equal(answer, 42));\n");
  await writeFile(join(fixture, '.gitignore'), '.repoproof/\ntools/\n');
  execFileSync('git', ['add', '.gitignore', 'app.mjs', 'app.test.mjs'], { cwd: fixture, stdio: 'pipe' });
  run(['init', '--goal', '验证离线安装的交接工具']);
  const record = JSON.parse(run(['run', '--check', 'tests', '--json', '--', process.execPath, '--test', 'app.test.mjs']));
  assert.equal(record.receipt.execution.status, 'passed');
  assert.equal(JSON.parse(run(['verify', '--json']))[0].freshness, 'unchanged');
  checks.push('installed init, real test execution, and unchanged verification');
  const manifestPath = join(fixture, '.repoproof', 'task.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.tasks[0].status = 'done';
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal(JSON.parse(run(['brief', '--json'])).tasks[0].status, 'evidenced_done');
  run(['brief', '--lang', 'en', '--output', '.repoproof/handoff.md']);
  checks.push('JSON task evidence and English file export');
  await writeFile(join(fixture, 'app.mjs'), 'export const answer = 43;\n');
  const changed = JSON.parse(run(['verify', '--json'], 1))[0];
  assert.equal(changed.execution, 'passed');
  assert.equal(changed.freshness, 'changed');
  assert.ok(changed.changes.some(change => change.path === 'app.mjs'));
  assert.equal(JSON.parse(run(['brief', '--json'], 1)).tasks[0].status, 'needs_recheck');
  checks.push('same HEAD changes invalidate task evidence without changing historical execution');
  const imported = JSON.parse(JSON.stringify(record.receipt));
  imported.command = [process.execPath, '-e', "require('node:fs').writeFileSync('executed.txt', 'unsafe')"];
  const importedPath = join(fixture, '.repoproof', 'imported.json');
  await writeFile(importedPath, JSON.stringify(imported));
  assert.equal(JSON.parse(run(['verify', importedPath, '--json'], 2))[0].freshness, 'invalid');
  assert.equal(existsSync(join(fixture, 'executed.txt')), false);
  checks.push('corrupt imported receipt rejected without executing its command');
  await mkdir(join(project, 'artifacts'), { recursive: true });
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(join(project, 'artifacts', 'package-smoke.json'), JSON.stringify({ package: basename(archive), sha256, node: process.version, platform: process.platform, passed: true, checks }, null, 2) + '\n');
  process.stdout.write(`离线安装与完整工作流验证通过：${checks.length} 项。\n`);
} finally {
  const actual = await realpath(fixture);
  const rel = relative(await realpath(tmpdir()), actual);
  if (!isAbsolute(rel) && !rel.startsWith('..' + sep) && !rel.includes(sep) && basename(actual).startsWith('repoproof-package-')) {
    await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } else throw new Error('Refusing to remove a fixture outside the expected temporary directory.');
}
