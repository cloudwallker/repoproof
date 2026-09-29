import { open } from 'node:fs/promises';
import type { TaskManifest } from './types.ts';

const MAX_BYTES = 1024 * 1024;
const MAX_TEXT = 10000;
const MAX_ITEMS = 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function invalid(): never {
  throw new Error('Invalid task manifest: check version, fields, ids and references.');
}

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !fields.includes(key) || !('value' in descriptors[key]))) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, nonempty = false): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT || (nonempty && !value.trim())) invalid();
  return value;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid();
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isInteger(length) || length < 0 || length > MAX_ITEMS || Reflect.ownKeys(descriptors).length !== length + 1) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result.push(descriptor.value);
  }
  return result;
}

export function validateManifest(input: unknown): TaskManifest {
  const value = object(input, ['schemaVersion', 'goal', 'checks', 'tasks']);
  if (value.schemaVersion !== 1) invalid();
  const goal = text(value.goal, true);
  const checkIds = new Set<string>();
  const checks = list(value.checks).map(inputCheck => {
    const check = object(inputCheck, ['id', 'title']);
    const checkId = id(check.id);
    if (checkIds.has(checkId)) invalid();
    checkIds.add(checkId);
    return { id: checkId, title: text(check.title, true) };
  });
  const taskIds = new Set<string>();
  const tasks = list(value.tasks).map(inputTask => {
    const task = object(inputTask, ['id', 'title', 'status', 'checks', 'note']);
    const taskId = id(task.id);
    if (taskIds.has(taskId)) invalid();
    taskIds.add(taskId);
    if (task.status !== 'todo' && task.status !== 'done' && task.status !== 'blocked') invalid();
    const refs = list(task.checks).map(id);
    if (new Set(refs).size !== refs.length || refs.some(ref => !checkIds.has(ref))) invalid();
    const result: TaskManifest['tasks'][number] = { id: taskId, title: text(task.title, true), status: task.status, checks: refs };
    if (Object.hasOwn(task, 'note')) result.note = text(task.note);
    return result;
  });
  return { schemaVersion: 1, goal, checks, tasks };
}

export async function loadManifest(path: string): Promise<TaskManifest> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Task manifest exceeds the 1 MiB limit or is not a file.');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('Task manifest exceeds the 1 MiB limit.');
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw new Error('Task manifest must be valid UTF-8 JSON.'); }
    return validateManifest(input);
  } finally { await file.close(); }
}
