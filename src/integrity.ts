import { createHash } from 'node:crypto';
import type { Snapshot, Receipt } from './types.ts';

export function canonicalJson(value: unknown): string {
  const visiting = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object') throw new TypeError('Only finite JSON values are supported.');
    if (visiting.has(item)) throw new TypeError('JSON cycle is not supported.');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError('Only plain JSON objects are supported.');
    }
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('JSON symbol keys are not supported.');
    visiting.add(item);
    try {
      if (Array.isArray(item)) {
        const parts: string[] = [];
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, i);
          if (!descriptor) throw new TypeError('JSON sparse arrays are not supported.');
          if (!('value' in descriptor)) throw new TypeError('JSON accessors are not supported.');
          parts.push(encode(descriptor.value));
        }
        return `[${parts.join(',')}]`;
      }
      return `{${Object.keys(item).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in descriptor)) throw new TypeError('JSON accessors are not supported.');
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      }).join(',')}}`;
    } finally { visiting.delete(item); }
  };
  return encode(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function snapshotDigest(snapshot: Omit<Snapshot, 'digest'> | Snapshot): string {
  return sha256(canonicalJson({
    head: snapshot.head,
    scope: { includeUntracked: [...snapshot.scope.includeUntracked].sort(), exclude: [...snapshot.scope.exclude].sort() },
    files: [...snapshot.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  }));
}

export function receiptDigest(receipt: Omit<Receipt, 'integrity'> | Receipt): string {
  const { integrity: _integrity, ...content } = receipt as Receipt;
  return sha256(canonicalJson(content));
}
