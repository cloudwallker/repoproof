import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, symlink, mkdir, access } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createRepo } from './helpers.mjs';

const module = await import('../src/recorder.ts').catch(() => ({}));
const runnable = () => assert.equal(typeof module.runCheck, 'function', 'runCheck must be implemented');
async function fixture(t, files = { 'tracked.txt': 'initial\n' }) {
  const repo = await createRepo(files);
  t.after(() => cleanup(repo.dir));
  repo.git(['add', '.']);
  repo.git(['commit', '-qm', 'fixture']);
  return repo;
}
async function cleanup(directory) {
  const base = resolve(tmpdir());
  const target = resolve(directory);
  const rel = relative(base, target);
  assert.ok(rel.startsWith('repoproof-tests-') && !rel.includes('..') && !isAbsolute(rel), 'cleanup must stay inside its isolated temporary fixture');
  for (const name of ['descendant.pid', 'parent.pid']) {
    try {
      const pid = Number(await readFile(join(target, name), 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    } catch {}
  }
  await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
let treeCapability;
async function canKillTree() {
  if (process.platform !== 'win32') return true;
  if (treeCapability !== undefined) return treeCapability;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const closed = new Promise((done) => child.once('close', done));
  await new Promise((done) => child.once('spawn', done));
  const code = await new Promise((done) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
    killer.once('error', () => done(1));
    killer.once('close', done);
  });
  if (code !== 0) child.kill('SIGKILL');
  await closed;
  treeCapability = code === 0;
  return treeCapability;
}
function options(repo, code, extra = {}) {
  return { cwd: repo.dir, checkId: 'test', command: [process.execPath, '-e', code], ...extra };
}

test('runCheck stores successful and failed executions with independent receipt files', async (t) => {
  runnable();
  const repo = await fixture(t);
  const first = await module.runCheck(options(repo, 'console.log("success"); console.error("diagnostic")'));
  const second = await module.runCheck(options(repo, 'process.exit(7)'));
  assert.deepEqual(first.receipt.execution, { status: 'passed', exitCode: 0, signal: null, reason: null });
  assert.equal(first.receipt.output.stdout, 'success\n');
  assert.equal(first.receipt.output.stderr, 'diagnostic\n');
  assert.equal(second.receipt.execution.status, 'failed');
  assert.equal(second.receipt.execution.exitCode, 7);
  assert.notEqual(first.receiptPath, second.receiptPath);
  assert.equal(first.receipt.before.digest, first.receipt.after.digest);
  assert.equal(dirname(first.receiptPath), join(repo.dir, '.repoproof', 'receipts'));
  assert.deepEqual(JSON.parse(await readFile(first.receiptPath, 'utf8')), first.receipt);
  assert.equal((await readdir(dirname(first.receiptPath))).length, 2);
});

test('runCheck records missing executable without exposing original errors or paths', async (t) => {
  runnable();
  const repo = await fixture(t);
  const result = await module.runCheck({ cwd: repo.dir, checkId: 'missing', command: ['repoproof-no-such-executable-FAKE', '--token', 'FAKE_TOKEN_VALUE'] });
  assert.equal(result.receipt.execution.status, 'incomplete');
  assert.equal(result.receipt.execution.reason, 'spawn_error');
  assert.equal(result.receipt.execution.exitCode, null);
  assert.ok(!JSON.stringify(result.receipt).includes('FAKE_TOKEN_VALUE'));
  assert.ok(!JSON.stringify(result.receipt).includes(repo.dir));
});

test('runCheck captures changes made by the executed program', async (t) => {
  runnable();
  const repo = await fixture(t);
  const result = await module.runCheck(options(repo, 'require("node:fs").writeFileSync("tracked.txt", "changed")'));
  assert.equal(result.receipt.execution.status, 'passed');
  assert.notEqual(result.receipt.before.digest, result.receipt.after.digest);
});

test('runCheck starts npm through its Node CLI instead of a Windows shell', async (t) => {
  runnable();
  const repo = await fixture(t);
  const result = await module.runCheck({ cwd: repo.dir, checkId: 'npm', command: ['npm', '--version'] });
  assert.equal(result.receipt.execution.status, 'passed');
  assert.match(result.receipt.output.stdout.trim(), /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
});

test('runCheck passes shell metacharacters and quotes literally and persists only masked summaries', async (t) => {
  runnable();
  const repo = await fixture(t);
  const literal = 'literal&|$"\'text';
  const command = [process.execPath, '-e', 'console.log(process.argv.slice(1).join("\\n")); console.error("Bearer FAKE_BEARER_VALUE")', '--', literal, '--password', 'FAKE_PASSWORD_VALUE'];
  const result = await module.runCheck({ cwd: repo.dir, checkId: 'literal', command });
  assert.equal(result.receipt.execution.status, 'passed');
  assert.ok(result.receipt.output.stdout.includes(literal));
  assert.ok(!JSON.stringify(result.receipt).includes('FAKE_PASSWORD_VALUE'));
  assert.ok(!JSON.stringify(result.receipt).includes('FAKE_BEARER_VALUE'));
  assert.equal(command.at(-1), 'FAKE_PASSWORD_VALUE');
});

test('runCheck bounds each output stream without killing a successful noisy process or splitting UTF8', async (t) => {
  runnable();
  const repo = await fixture(t);
  const result = await module.runCheck(options(repo, 'process.stdout.write("a".repeat(65535) + "中" + "b".repeat(100000)); process.stderr.write("e".repeat(200000))'));
  assert.equal(result.receipt.execution.status, 'passed');
  assert.equal(result.receipt.output.truncated, true);
  assert.ok(Buffer.byteLength(result.receipt.output.stdout) <= 65536);
  assert.ok(Buffer.byteLength(result.receipt.output.stderr) <= 65536);
  assert.ok(!result.receipt.output.stdout.includes('\uFFFD'));
});

test('runCheck masks a private key cut by the output limit', async (t) => {
  runnable();
  const repo = await fixture(t);
  const result = await module.runCheck(options(repo, 'process.stdout.write("-----BEGIN PRIVATE KEY-----\\n" + "FAKE_PRIVATE_VALUE".repeat(6000))'));
  assert.equal(result.receipt.output.truncated, true);
  assert.ok(!JSON.stringify(result.receipt).includes('FAKE_PRIVATE_VALUE'));
});

test('runCheck validates executable, check id and timeout before execution', async (t) => {
  runnable();
  const repo = await fixture(t);
  for (const patch of [
    { command: [] }, { command: [''] }, { command: [null] }, { command: [process.execPath, , 'argument'] }, { checkId: '' }, { checkId: '../unsafe' },
    { command: ['node', 'a'.repeat(65537)] }, { command: ['node', ...Array(1024).fill('argument')] },
    { checkId: 'a'.repeat(65) }, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 },
    { timeoutMs: Number.MAX_SAFE_INTEGER }, { timeoutMs: NaN }, { timeoutMs: '100' },
  ]) {
    await assert.rejects(module.runCheck(options(repo, 'require("node:fs").writeFileSync("executed", "bad")', patch)));
  }
  await assert.rejects(access(join(repo.dir, 'executed')));
});

for (const interruption of ['timeout', 'SIGINT']) {
  test(`runCheck reaps its direct child after ${interruption} even if process-tree termination is denied`, async (t) => {
    runnable();
    const treeSupported = await canKillTree();
    const repo = await fixture(t);
    const originalSpawn = childProcess.spawn;
    let child;
    const baseline = process.listenerCount('SIGINT');
    childProcess.spawn = function (...args) {
      const spawned = originalSpawn.apply(this, args);
      if (args[0] === process.execPath) child = spawned;
      return spawned;
    };
    syncBuiltinESMExports();
    let interrupt;
    try {
      const pending = module.runCheck(options(repo, 'setInterval(() => {},1000)', { timeoutMs: 1000 }));
      if (interruption === 'SIGINT') {
        interrupt = setInterval(() => {
          if (child?.pid && process.listenerCount('SIGINT') > baseline) {
            clearInterval(interrupt);
            process.emit('SIGINT');
          }
        }, 20);
      }
      const result = await pending;
      assert.ok(child?.pid, 'the test must capture the real child process handle');
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'runCheck must wait until its real direct child exits before returning');
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
      assert.equal(result.receipt.execution.status, 'incomplete');
      assert.equal(result.receipt.execution.reason, interruption === 'SIGINT' ? 'interrupted' : 'timeout');
      assert.equal(process.listenerCount('SIGINT'), baseline);
      if (!treeSupported) assert.match(result.receipt.output.stderr, /process-tree termination failed.*descendant/i);
    } finally {
      clearInterval(interrupt);
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((done) => child.once('exit', done));
        child.ref();
        child.kill('SIGKILL');
        await closed;
      }
    }
  });
}

test('runCheck bounds cleanup failure and retains fixed warnings inside the stderr limit', async (t) => {
  runnable();
  const repo = await fixture(t);
  const originalSpawn = childProcess.spawn;
  const originalProcessKill = process.kill;
  let child;
  let actualKill;
  childProcess.spawn = function (...args) {
    if (args[0] === 'taskkill.exe') throw new Error('FAKE_PRIVATE_TASKKILL_FAILURE');
    const spawned = originalSpawn.apply(this, args);
    if (args[0] === process.execPath) {
      child = spawned;
      actualKill = spawned.kill.bind(spawned);
      spawned.kill = () => false;
    }
    return spawned;
  };
  process.kill = function (pid, signal) {
    if (child && pid === -child.pid) throw Object.assign(new Error('FAKE_PRIVATE_GROUP_FAILURE'), { code: 'EPERM' });
    return originalProcessKill(pid, signal);
  };
  syncBuiltinESMExports();
  try {
    const result = await module.runCheck(options(repo, 'process.stderr.write("e".repeat(65536));setInterval(() => {},1000)', { timeoutMs: 1000 }));
    assert.equal(result.receipt.execution.status, 'incomplete');
    assert.equal(result.receipt.execution.reason, 'timeout');
    assert.match(result.receipt.output.stderr, /Process-tree termination failed.*descendant/);
    assert.match(result.receipt.output.stderr, /Direct child termination could not be confirmed within the cleanup deadline/);
    assert.ok(Buffer.byteLength(result.receipt.output.stderr) <= 65536);
    assert.equal(result.receipt.output.truncated, true);
    assert.ok(!JSON.stringify(result.receipt).includes('FAKE_PRIVATE_'));
    assert.ok(result.receipt.durationMs < 10000, 'failed cleanup must have a bounded wait');
  } finally {
    childProcess.spawn = originalSpawn;
    process.kill = originalProcessKill;
    syncBuiltinESMExports();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((done) => child.once('exit', done));
      child.ref();
      actualKill('SIGKILL');
      await closed;
    }
  }
});

test('runCheck terminates its parent and descendant processes on timeout', async (t) => {
  runnable();
  if (!(await canKillTree())) return t.skip('Sandbox denies Windows taskkill; real process-tree cleanup is verified outside the sandbox.');
  const repo = await fixture(t);
  await repo.write('descendant.cjs', 'require("node:fs").writeFileSync("descendant.pid", String(process.pid)); setInterval(() => {}, 1000)');
  const code = 'require("node:fs").writeFileSync("parent.pid", String(process.pid)); require("node:child_process").spawn(process.execPath,["descendant.cjs"],{stdio:"inherit"}); setInterval(() => {},1000)';
  const result = await module.runCheck(options(repo, code, { timeoutMs: 1200 }));
  assert.equal(result.receipt.execution.status, 'incomplete');
  assert.equal(result.receipt.execution.reason, 'timeout');
  for (const filename of ['parent.pid', 'descendant.pid']) {
    const pid = Number(await readFile(join(repo.dir, filename), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

test('runCheck handles SIGINT and removes its process listener', async (t) => {
  runnable();
  if (!(await canKillTree())) return t.skip('Sandbox denies Windows taskkill; SIGINT cleanup is verified outside the sandbox.');
  const repo = await fixture(t);
  const count = process.listenerCount('SIGINT');
  const pending = module.runCheck(options(repo, 'console.log("started"); setInterval(() => {},1000)', { timeoutMs: 3000 }));
  const interrupt = setInterval(() => {
    if (process.listenerCount('SIGINT') > count) {
      clearInterval(interrupt);
      process.emit('SIGINT');
    }
  }, 20);
  t.after(() => clearInterval(interrupt));
  const result = await pending;
  assert.equal(result.receipt.execution.status, 'incomplete');
  assert.equal(result.receipt.execution.reason, 'interrupted');
  assert.equal(result.receipt.execution.signal, 'SIGINT');
  assert.equal(process.listenerCount('SIGINT'), count);
});

test('runCheck terminates descendants that retain pipes after their parent exits', async (t) => {
  runnable();
  if (!(await canKillTree())) return t.skip('Sandbox denies Windows taskkill; orphan pipe cleanup is verified outside the sandbox.');
  const repo = await fixture(t);
  await repo.write('descendant.cjs', 'require("node:fs").writeFileSync("descendant.pid", String(process.pid)); setInterval(() => {}, 1000)');
  const code = 'const fs=require("node:fs");require("node:child_process").spawn(process.execPath,["descendant.cjs"],{stdio:"inherit"});const wait=setInterval(()=>{if(fs.existsSync("descendant.pid"))process.exit(0)},20)';
  const result = await module.runCheck(options(repo, code, { timeoutMs: 1200 }));
  assert.ok(['passed', 'incomplete'].includes(result.receipt.execution.status));
  if (result.receipt.execution.status === 'incomplete') assert.equal(result.receipt.execution.reason, 'timeout');
  const pid = Number(await readFile(join(repo.dir, 'descendant.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('runCheck preserves a receipt if the program makes after-snapshot unavailable', async (t) => {
  runnable();
  const repo = await fixture(t);
  const result = await module.runCheck(options(repo, 'require("node:fs").renameSync(".git", ".git-disabled")'));
  assert.equal(result.receipt.execution.status, 'passed');
  assert.equal(result.receipt.after, null);
  assert.equal(JSON.parse(await readFile(result.receiptPath, 'utf8')).after, null);
});

for (const location of ['.repoproof', '.repoproof/receipts']) {
  test(`runCheck refuses linked receipt directory ${location}`, async (t) => {
    runnable();
    const repo = await fixture(t);
    const other = await createRepo();
    t.after(() => cleanup(other.dir));
    await mkdir(dirname(join(repo.dir, location)), { recursive: true });
    try { await symlink(other.dir, join(repo.dir, location), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('This platform does not permit creating a directory link.');
      throw error;
    }
    await assert.rejects(module.runCheck(options(repo, 'console.log("must not run")')), /directory|link|path/i);
    assert.deepEqual(await readdir(other.dir), ['.git']);
  });
}
