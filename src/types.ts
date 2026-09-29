export type FileKind = 'file' | 'symlink' | 'missing' | 'submodule';
export interface FileFingerprint { path: string; kind: FileKind; sha256: string | null }
export interface SnapshotIssue { path: string; code: string; message: string }
export interface Snapshot {
  schemaVersion: 1; head: string | null; capturedAt: string;
  scope: { includeUntracked: string[]; exclude: string[] };
  files: FileFingerprint[]; issues: SnapshotIssue[];
  untrackedExcluded: number; digest: string;
}
export interface Receipt {
  schemaVersion: 1; id: string; checkId: string;
  startedAt: string; finishedAt: string; durationMs: number;
  command: string[]; environment: { node: string; platform: string };
  execution: { status: 'passed' | 'failed' | 'incomplete'; exitCode: number | null;
    signal: string | null; reason: string | null };
  before: Snapshot; after: Snapshot | null;
  output: { stdout: string; stderr: string; truncated: boolean };
  integrity: { algorithm: 'sha256'; digest: string };
}
export interface Change { path: string; kind: 'added' | 'modified' | 'deleted' | 'type_changed' | 'head_changed' }
export interface Verification {
  receiptId: string; checkId: string;
  execution: 'passed' | 'failed' | 'incomplete' | 'unknown';
  freshness: 'unchanged' | 'changed' | 'unverifiable' | 'invalid';
  changes: Change[]; reasons: string[]; verifiedAt: string;
}
export interface TaskManifest {
  schemaVersion: 1; goal: string;
  checks: { id: string; title: string }[];
  tasks: { id: string; title: string; status: 'todo' | 'done' | 'blocked'; checks: string[]; note?: string }[];
}
