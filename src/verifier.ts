import { canonicalJson, snapshotDigest, receiptDigest } from './integrity.ts';
import { captureSnapshot } from './snapshot.ts';
import type { Receipt, Snapshot, Verification, Change } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid receipt structure, semantics, or integrity.');
}

// Inspect descriptors before reading fields so non-JSON accessors never run.
function object(value: unknown, keys: string[]): Record<string, unknown> {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  requireValid(prototype === Object.prototype || prototype === null);
  const own = Reflect.ownKeys(value);
  requireValid(own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key)));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValid(descriptor && 'value' in descriptor && descriptor.enumerable);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, max: number): unknown[] {
  requireValid(Array.isArray(value) && value.length <= max);
  requireValid(Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    requireValid(descriptor && 'value' in descriptor && descriptor.enumerable);
  }
  return value;
}

function text(value: unknown, max: number, nonempty = false): asserts value is string {
  requireValid(typeof value === 'string' && value.length <= max && (!nonempty || value.trim().length > 0));
}

function timestamp(value: unknown): number {
  text(value, 24, true);
  requireValid(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value));
  const time = Date.parse(value);
  requireValid(Number.isFinite(time) && new Date(time).toISOString() === value);
  return time;
}

function fingerprintPath(value: unknown): asserts value is string {
  text(value, 4096);
  requireValid(value.length > 0 && !value.includes('\0'));
  const parts = value.split('/');
  requireValid(parts.every((part) => part !== '' && part !== '.' && part !== '..'));
  requireValid(!['.git', '.repoproof'].includes(parts[0].toLowerCase()));
}

function includePath(value: unknown): asserts value is string {
  if (value === '.') return;
  fingerprintPath(value);
  requireValid(!value.includes('\\') && !value.includes(':'));
  requireValid(!value.split('/').some((part) => part.toLowerCase() === '.git'));
}

function paths(value: unknown): string[] {
  const entries = array(value, 1000);
  const seen = new Set<string>();
  for (const path of entries) { includePath(path); requireValid(!seen.has(path)); seen.add(path); }
  return entries as string[];
}

function validateSnapshot(input: unknown): Snapshot {
  const snapshot = object(input, ['schemaVersion', 'head', 'capturedAt', 'scope', 'files', 'issues', 'untrackedExcluded', 'digest']);
  requireValid(snapshot.schemaVersion === 1);
  requireValid(snapshot.head === null || typeof snapshot.head === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(snapshot.head));
  timestamp(snapshot.capturedAt);
  const scope = object(snapshot.scope, ['includeUntracked', 'exclude']);
  paths(scope.includeUntracked);
  const exclude = array(scope.exclude, 1); requireValid(exclude.length === 1 && exclude[0] === '.repoproof/');
  const files = array(snapshot.files, 100000);
  const byPath = new Map<string, Record<string, unknown>>();
  for (const inputFile of files) {
    const file = object(inputFile, ['path', 'kind', 'sha256']); fingerprintPath(file.path);
    requireValid(!byPath.has(file.path)); byPath.set(file.path, file);
    requireValid(['file', 'symlink', 'missing', 'submodule'].includes(file.kind as string));
    requireValid(file.sha256 === null || typeof file.sha256 === 'string' && HASH.test(file.sha256));
    if (file.kind === 'missing') requireValid(file.sha256 === null);
  }
  const issues = array(snapshot.issues, 100000);
  const issuePaths = new Set<string>();
  for (const inputIssue of issues) {
    const issue = object(inputIssue, ['path', 'code', 'message']); fingerprintPath(issue.path);
    requireValid(byPath.has(issue.path)); text(issue.code, 64, true); text(issue.message, 4096, true);
    requireValid(/^[a-z][a-z0-9_]*$/.test(issue.code)); issuePaths.add(issue.path);
  }
  for (const [path, file] of byPath) {
    // Capture failures (including unsupported submodules) have null fingerprints and an issue.
    if (file.kind !== 'missing' && file.sha256 === null) requireValid(issuePaths.has(path));
    if (file.kind === 'submodule') requireValid(issuePaths.has(path));
  }
  requireValid(Number.isSafeInteger(snapshot.untrackedExcluded) && (snapshot.untrackedExcluded as number) >= 0);
  requireValid(typeof snapshot.digest === 'string' && HASH.test(snapshot.digest));
  const typed = snapshot as unknown as Snapshot;
  requireValid(snapshotDigest(typed) === typed.digest);
  return typed;
}

export function validateReceipt(input: unknown): Receipt {
  const receipt = object(input, ['schemaVersion', 'id', 'checkId', 'startedAt', 'finishedAt', 'durationMs', 'command',
    'environment', 'execution', 'before', 'after', 'output', 'integrity']);
  requireValid(receipt.schemaVersion === 1);
  requireValid(typeof receipt.id === 'string' && UUID.test(receipt.id));
  requireValid(typeof receipt.checkId === 'string' && CHECK_ID.test(receipt.checkId));
  const start = timestamp(receipt.startedAt); const finish = timestamp(receipt.finishedAt);
  requireValid(finish >= start);
  requireValid(typeof receipt.durationMs === 'number' && Number.isFinite(receipt.durationMs) &&
    receipt.durationMs >= 0 && receipt.durationMs <= Number.MAX_SAFE_INTEGER);
  const command = array(receipt.command, 1024); requireValid(command.length > 0);
  for (const part of command) { text(part, 65536); requireValid(!part.includes('\0')); }
  text(command[0], 65536, true);
  const environment = object(receipt.environment, ['node', 'platform']);
  text(environment.node, 128, true); text(environment.platform, 128, true);
  requireValid(!environment.node.includes('\0') && !environment.platform.includes('\0'));
  const execution = object(receipt.execution, ['status', 'exitCode', 'signal', 'reason']);
  requireValid(execution.exitCode === null || Number.isInteger(execution.exitCode) &&
    (execution.exitCode as number) >= -2147483648 && (execution.exitCode as number) <= 4294967295);
  requireValid(execution.signal === null || typeof execution.signal === 'string' && /^SIG[A-Z0-9]{1,24}$/.test(execution.signal));
  if (execution.status === 'passed') {
    requireValid(execution.exitCode === 0 && execution.signal === null && execution.reason === null);
  } else if (execution.status === 'failed') {
    requireValid(execution.exitCode !== null && execution.exitCode !== 0 && execution.signal === null && execution.reason === null);
  } else {
    requireValid(execution.status === 'incomplete' && ['timeout', 'interrupted', 'spawn_error'].includes(execution.reason as string));
    if (execution.reason === 'spawn_error') requireValid(execution.exitCode === null && execution.signal === null);
  }
  const before = validateSnapshot(receipt.before);
  const after = receipt.after === null ? null : validateSnapshot(receipt.after);
  if (after) {
    requireValid(canonicalJson([...before.scope.includeUntracked].sort()) === canonicalJson([...after.scope.includeUntracked].sort()));
    requireValid(timestamp(after.capturedAt) >= timestamp(before.capturedAt));
  }
  const output = object(receipt.output, ['stdout', 'stderr', 'truncated']);
  text(output.stdout, 262144); text(output.stderr, 262144); requireValid(typeof output.truncated === 'boolean');
  const integrity = object(receipt.integrity, ['algorithm', 'digest']);
  requireValid(integrity.algorithm === 'sha256' && typeof integrity.digest === 'string' && HASH.test(integrity.digest));
  requireValid(receiptDigest(receipt as unknown as Receipt) === integrity.digest);
  // Keep subsequent async capture independent of any caller mutation of the original object.
  return JSON.parse(canonicalJson(receipt)) as Receipt;
}

function safeIdentifier(input: unknown, key: string, format: RegExp): string {
  try {
    if (input === null || typeof input !== 'object') return 'unknown';
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' && format.test(descriptor.value)
      ? descriptor.value : 'unknown';
  } catch { return 'unknown'; }
}

function changesBetween(before: Snapshot, current: Snapshot): Change[] {
  const changes: Change[] = [];
  if (before.head !== current.head) changes.push({ path: 'HEAD', kind: 'head_changed' });
  const oldFiles = new Map(before.files.map((file) => [file.path, file]));
  const newFiles = new Map(current.files.map((file) => [file.path, file]));
  for (const path of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
    const previous = oldFiles.get(path); const next = newFiles.get(path);
    const oldPresent = previous && previous.kind !== 'missing';
    const newPresent = next && next.kind !== 'missing';
    if (!previous && next || !oldPresent && newPresent) changes.push({ path, kind: 'added' });
    else if (previous && !next || oldPresent && !newPresent) changes.push({ path, kind: 'deleted' });
    else if (oldPresent && newPresent) {
      if (previous.kind !== next.kind) changes.push({ path, kind: 'type_changed' });
      else if (previous.sha256 !== next.sha256) changes.push({ path, kind: 'modified' });
    }
  }
  return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function verifyReceipt(input: unknown, cwd: string): Promise<Verification> {
  const result: Verification = {
    receiptId: safeIdentifier(input, 'id', UUID), checkId: safeIdentifier(input, 'checkId', CHECK_ID),
    execution: 'unknown', freshness: 'invalid', changes: [], reasons: [], verifiedAt: new Date().toISOString(),
  };
  let receipt: Receipt;
  try { receipt = validateReceipt(input); }
  catch { result.reasons.push('收据的结构、语义或完整性校验失败。'); return result; }
  result.execution = receipt.execution.status;
  result.freshness = 'unverifiable';
  if (process.platform === 'win32' && [receipt.before, receipt.after].some((snapshot) =>
    snapshot?.files.some((file) => file.path.includes(':') || file.path.includes('\\')))) {
    result.reasons.push('收据包含 Windows 无法安全解释的 POSIX 文件名，无法在此平台核验。');
    return result;
  }
  if (receipt.before.issues.length || receipt.after?.issues.length) result.reasons.push('历史快照包含无法安全读取或不支持的文件。');
  if (!receipt.after) result.reasons.push('缺少执行后的快照。');
  else if (receipt.before.digest !== receipt.after.digest) result.reasons.push('执行前后快照不同，无法确定检查对应的文件状态。');
  if (result.reasons.length) return result;
  let current: Snapshot;
  try { current = await captureSnapshot(cwd, receipt.before.scope.includeUntracked); }
  catch { result.reasons.push('无法读取当前 Git 项目的快照。'); return result; }
  if (current.issues.length) { result.reasons.push('当前快照包含无法安全读取或不支持的文件。'); return result; }
  result.changes = changesBetween(receipt.before, current);
  result.freshness = result.changes.length ? 'changed' : 'unchanged';
  if (result.changes.length) result.reasons.push('当前 HEAD 或纳入检查的文件已变化，请重新执行检查。');
  return result;
}
