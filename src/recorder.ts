import { spawn } from 'node:child_process';
import { mkdir, lstat, realpath, open, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { resolveRepoRoot, captureSnapshot } from './snapshot.ts';
import { receiptDigest } from './integrity.ts';
import { redactText, redactCommand } from './redact.ts';
import type { Receipt } from './types.ts';

const OUTPUT_LIMIT = 65536;
const MAX_TIMEOUT = 24 * 60 * 60 * 1000;

type Options = { cwd: string; checkId: string; command: string[]; includeUntracked?: string[]; timeoutMs?: number };

function validateOptions(options: Options): number {
  if (!options || typeof options.cwd !== 'string' || !options.cwd ||
      typeof options.checkId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(options.checkId) ||
      !Array.isArray(options.command) || !options.command.length || options.command.length > 1024 ||
      Array.from(options.command).some((part) => typeof part !== 'string' || part.includes('\0') || part.length > 65536) ||
      !options.command[0].trim()) {
    throw new Error('Invalid command, check id, or working directory.');
  }
  const timeout = options.timeoutMs === undefined ? 120000 : options.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT) {
    throw new Error('Timeout must be a positive integer no greater than 24 hours.');
  }
  return timeout;
}

async function receiptDirectory(root: string): Promise<string> {
  let path = root;
  for (const segment of ['.repoproof', 'receipts']) {
    path = join(path, segment);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Unable to create receipt directory.'); }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Receipt directory must be a real directory, not a link.');
    const actual = await realpath(path);
    const rel = relative(root, actual);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || relative(path, actual)) {
      throw new Error('Receipt directory path escapes the repository.');
    }
  }
  return path;
}

function executable(command: string[], root: string): string[] {
  if (process.platform !== 'win32') return command;
  const name = basename(command[0]).toLowerCase().replace(/\.cmd$/, '');
  if (name !== 'npm' && name !== 'npx') return command;
  const directories = [dirname(process.execPath)];
  if (isAbsolute(command[0]) || command[0].includes('\\') || command[0].includes('/')) {
    directories.unshift(dirname(resolve(root, command[0])));
  } else {
    directories.push(...(process.env.PATH || '').split(delimiter).filter(Boolean));
  }
  for (const directory of directories) {
    const script = join(directory, 'node_modules', 'npm', 'bin', name + '-cli.js');
    if (existsSync(script)) return [process.execPath, script, ...command.slice(1)];
  }
  throw new Error('Unable to resolve the Node CLI for npm or npx.');
}

function outputCollector() {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    append(chunk: Buffer) {
      const available = OUTPUT_LIMIT - size;
      if (chunk.length > available) truncated = true;
      if (available > 0) {
        const kept = chunk.subarray(0, available);
        chunks.push(kept);
        size += kept.length;
      }
    },
    finish(root: string) {
      const decoder = new StringDecoder('utf8');
      let text = decoder.write(Buffer.concat(chunks, size));
      if (!truncated) text += decoder.end();
      text = redactText(text, root);
      const bytes = Buffer.from(text);
      if (bytes.length > OUTPUT_LIMIT) {
        truncated = true;
        text = new StringDecoder('utf8').write(bytes.subarray(0, OUTPUT_LIMIT));
      }
      return { text, truncated };
    },
  };
}

async function killTree(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
  return new Promise<boolean>((done) => {
    let killer: ReturnType<typeof spawn>;
    try { killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }); }
    catch { done(false); return; }
    let completed = false;
    const finish = (success: boolean) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      done(success);
    };
    const timer = setTimeout(() => {
      try { killer.kill('SIGKILL'); } catch { /* The timeout is reported as tree cleanup failure. */ }
      finish(false);
    }, 5000);
    killer.once('error', () => finish(false));
    killer.once('close', (code) => finish(code === 0));
  });
}

async function execute(command: string[], root: string, timeout: number) {
  const stdout = outputCollector();
  const stderr = outputCollector();
  const diagnostics: string[] = [];
  const execution: Receipt['execution'] = { status: 'incomplete', exitCode: null, signal: null, reason: 'spawn_error' };
  await new Promise<void>((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      const actual = executable(command, root);
      child = spawn(actual[0], actual.slice(1), { cwd: root, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { done(); return; }
    let settled = false;
    let stopping = false;
    let exited = false;
    let notifyExit: () => void;
    const exit = new Promise<void>((resolveExit) => { notifyExit = resolveExit; });
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', onInterrupt);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      done();
    };
    const stop = async (reason: string) => {
      if (settled || stopping) return;
      stopping = true;
      execution.status = 'incomplete';
      execution.reason = reason === 'SIGINT' ? 'interrupted' : reason;
      execution.signal = reason === 'SIGINT' ? 'SIGINT' : null;
      const treeKilled = child.pid ? await killTree(child.pid) : true;
      if (!treeKilled) diagnostics.push('[RepoProof] Process-tree termination failed; descendant cleanup cannot be guaranteed.');
      if (!exited) {
        try { child.kill('SIGKILL'); } catch { /* Confirm actual exit below rather than trusting the kill request. */ }
        const stopped = await new Promise<boolean>((resolveStopped) => {
          const deadline = setTimeout(() => resolveStopped(false), 2000);
          void exit.then(() => { clearTimeout(deadline); resolveStopped(true); });
        });
        if (!stopped) diagnostics.push('[RepoProof] Direct child termination could not be confirmed within the cleanup deadline.');
      }
      execution.exitCode = exitCode;
      if (reason !== 'SIGINT') execution.signal = signal;
      finish();
    };
    const onInterrupt = () => { void stop('SIGINT'); };
    const timer = setTimeout(() => { void stop('timeout'); }, timeout);
    process.on('SIGINT', onInterrupt);
    child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));
    child.once('error', () => {
      if (!child.pid) { exited = true; notifyExit(); }
      if (!stopping) { execution.reason = 'spawn_error'; finish(); }
    });
    child.once('exit', (code, receivedSignal) => { exited = true; exitCode = code; signal = receivedSignal; notifyExit(); });
    child.once('close', (code, receivedSignal) => {
      if (settled || stopping) return;
      execution.exitCode = code;
      execution.signal = receivedSignal || signal;
      execution.status = code === 0 ? 'passed' : code === null ? 'incomplete' : 'failed';
      execution.reason = code === null ? (receivedSignal || signal ? 'interrupted' : 'spawn_error') : null;
      finish();
    });
  });
  const out = stdout.finish(root);
  const err = stderr.finish(root);
  if (diagnostics.length) {
    const combined = Buffer.from(diagnostics.join('\n') + '\n' + err.text);
    if (combined.length > OUTPUT_LIMIT) err.truncated = true;
    err.text = new StringDecoder('utf8').write(combined.subarray(0, OUTPUT_LIMIT));
  }
  return { execution, output: { stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated } };
}

export async function runCheck(options: Options): Promise<{ receipt: Receipt; receiptPath: string }> {
  const timeout = validateOptions(options);
  const root = resolveRepoRoot(options.cwd);
  await receiptDirectory(root);
  const before = await captureSnapshot(root, options.includeUntracked);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const { execution, output } = await execute(options.command, root, timeout);
  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, Math.round(performance.now() - start));
  let after: Receipt['after'] = null;
  try { after = await captureSnapshot(root, options.includeUntracked); } catch { /* Preserve execution evidence even if Git becomes unavailable. */ }
  const unsigned: Omit<Receipt, 'integrity'> = {
    schemaVersion: 1, id: randomUUID(), checkId: options.checkId,
    startedAt, finishedAt, durationMs, command: redactCommand(options.command, root),
    environment: { node: process.version, platform: process.platform },
    execution, before, after, output,
  };
  const receipt: Receipt = { ...unsigned, integrity: { algorithm: 'sha256', digest: receiptDigest(unsigned) } };
  const directory = await receiptDirectory(root);
  const receiptPath = join(directory, receipt.id + '.json');
  const temporaryPath = join(directory, '.' + randomUUID() + '.tmp');
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(receipt, null, 2) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await receiptDirectory(root);
    await rename(temporaryPath, receiptPath);
  } catch {
    try { await unlink(temporaryPath); } catch { /* A failed temporary file is never treated as a receipt. */ }
    throw new Error('Unable to save the command receipt.');
  }
  return { receipt, receiptPath };
}
