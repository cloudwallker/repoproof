import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../src/report.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
function api(name) {
  assert.equal(typeof module[name], 'function', `${name} must implement the report contract`);
  return module[name];
}
const snapshot = { schemaVersion: 1, head: null, capturedAt: '2026-09-29T00:00:00Z', scope: { includeUntracked: [], exclude: ['.repoproof/'] }, files: [], issues: [], untrackedExcluded: 0, digest: 'a'.repeat(64) };
function entry(checkId, execution = 'passed', freshness = 'unchanged', day = 1) {
  const date = `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`;
  return {
    receipt: { schemaVersion: 1, id: `${checkId}-${day}`, checkId, startedAt: date, finishedAt: date, durationMs: 0, command: ['node', '--test'], environment: { node: '24.15.0', platform: 'win32' }, execution: { status: execution, exitCode: execution === 'passed' ? 0 : 1, signal: null, reason: null }, before: snapshot, after: snapshot, output: { stdout: '', stderr: '', truncated: false }, integrity: { algorithm: 'sha256', digest: 'b'.repeat(64) } },
    verification: { receiptId: `${checkId}-${day}`, checkId, execution, freshness, changes: [], reasons: [], verifiedAt: date },
  };
}
function manifest(tasks, checks = ['a', 'b', 'unbound']) {
  return { schemaVersion: 1, goal: '交付目标', checks: checks.map(id => ({ id, title: `检查 ${id}` })), tasks: tasks.map(([id, status, refs]) => ({ id, title: id, status, checks: refs })) };
}

test('brief derives evidence, self report, recheck, todo and blocked independently', () => {
  const data = api('briefData')(manifest([
    ['evidence', 'done', ['a']], ['self', 'done', []], ['missing', 'done', ['b']], ['todo', 'todo', ['a']], ['blocked', 'blocked', ['a']],
  ]), [entry('a')]);
  assert.deepEqual(data.tasks.map(task => task.status), ['evidenced_done', 'self_reported_done', 'self_reported_done', 'todo', 'blocked']);
  assert.equal(data.tasks[2].checks[0].execution, 'unknown');
  assert.equal(data.tasks[2].checks[0].freshness, 'unverifiable');
  assert.equal(data.tasks[2].checks[0].receiptId, null);
  assert.match(data.tasks[2].checks[0].reasons.join(' '), /缺少执行记录/);
  assert.equal(data.schemaVersion, 1);
  assert.deepEqual(data.checks.map(check => check.id), ['a', 'b', 'unbound']);
  assert.ok(data.limitations.length >= 3);
  assert.doesNotThrow(() => JSON.stringify(data));
});

test('newer failure wins over earlier pass regardless of entry ordering', () => {
  const data = api('briefData')(manifest([['done', 'done', ['a']]]), [entry('a', 'failed', 'unchanged', 3), entry('a', 'passed', 'unchanged', 1)]);
  assert.equal(data.tasks[0].status, 'needs_recheck');
  assert.equal(data.tasks[0].checks[0].execution, 'failed');
  assert.equal(data.tasks[0].checks[0].receiptId, 'a-3');
});

test('brief displays the recorded file scope and excluded untracked count', () => {
  const record = entry('a');
  record.receipt.before = { ...record.receipt.before, scope: { includeUntracked: ['new feature'], exclude: ['.repoproof/'] }, untrackedExcluded: 3 };
  const m = manifest([['done', 'done', ['a']]], ['a']);
  const data = api('briefData')(m, [record]);
  assert.equal(data.checks[0].scope.untrackedExcluded, 3);
  assert.deepEqual(data.checks[0].scope.includeUntracked, ['new feature']);
  assert.match(api('renderBrief')(m, [record], 'zh'), /执行时排除的未跟踪文件: 3/);
  assert.match(api('renderBrief')(m, [record], 'en'), /Untracked files excluded at execution: 3/);
});

test('partly missing, changed, unknown and invalid evidence require recheck', () => {
  const derive = api('briefData');
  const m = manifest([['done', 'done', ['a', 'b']]]);
  assert.equal(derive(m, [entry('a')]).tasks[0].status, 'needs_recheck');
  for (const freshness of ['changed', 'unverifiable', 'invalid']) {
    assert.equal(derive(manifest([['done', 'done', ['a']]]), [entry('a', 'passed', freshness)]).tasks[0].status, 'needs_recheck');
  }
  const invalid = { receipt: null, verification: { ...entry('a').verification, freshness: 'invalid', execution: 'unknown', reasons: ['损坏记录'] } };
  const data = derive(manifest([['done', 'done', ['a']]]), [entry('a'), invalid]);
  assert.equal(data.tasks[0].status, 'needs_recheck');
  assert.equal(data.checks[0].freshness, 'invalid');
  assert.ok(data.checks[0].reasons.includes('损坏记录'));
});

test('unbound and invalid unmatched records remain visible', () => {
  const bad = { receipt: null, verification: { ...entry('unknown-check').verification, freshness: 'invalid', execution: 'unknown', reasons: ['invalid receipt'] } };
  const data = api('briefData')(manifest([['done', 'done', ['a']]]), [entry('a'), entry('outside'), bad]);
  assert.ok(data.checks.some(check => check.id === 'outside'));
  assert.ok(data.checks.some(check => check.id === 'unknown-check' && check.freshness === 'invalid'));
});

test('an older invalid record remains visible without replacing newer dated valid evidence', () => {
  const data = api('briefData')(manifest([['done', 'done', ['a']]]), [entry('a', 'unknown', 'invalid', 1), entry('a', 'passed', 'unchanged', 3)]);
  assert.equal(data.tasks[0].status, 'evidenced_done');
  assert.equal(data.tasks[0].checks[0].receiptId, 'a-3');
  assert.ok(data.checks.some(check => check.receiptId === 'a-1' && check.freshness === 'invalid'));
});

test('a verification without any receipt cannot grant execution evidence', () => {
  const data = api('briefData')(manifest([['done', 'done', ['a']]]), [{ receipt: null, verification: entry('a').verification }]);
  assert.equal(data.tasks[0].status, 'self_reported_done');
  assert.equal(data.checks[0].execution, 'unknown');
  assert.equal(data.checks[0].freshness, 'unverifiable');
  assert.equal(data.checks[0].receiptId, null);
});

test('Chinese and English reports explain historical execution and evidence limits', () => {
  const m = manifest([['done', 'done', ['a']], ['self', 'done', []], ['todo', 'todo', []], ['blocked', 'blocked', []]]);
  const zh = api('renderBrief')(m, [entry('a')]);
  const en = api('renderBrief')(m, [entry('a')], 'en');
  for (const text of ['完成且有执行记录', '自述完成', '未完成', '阻塞', '历史', '环境', '签名', '下一步']) assert.ok(zh.includes(text), text);
  for (const text of ['Completed with execution evidence', 'Self-reported done', 'Todo', 'Blocked', 'historical', 'environment', 'signature', 'Next steps']) assert.ok(en.includes(text), text);
  const verification = api('renderVerification')([entry('a').verification, entry('b', 'failed', 'changed').verification], 'en');
  for (const text of ['a-1', 'b-1', 'passed', 'failed', 'unchanged', 'changed']) assert.ok(verification.includes(text));
});

test('Markdown renders untrusted strings as text while JSON preserves originals', () => {
  const unsafe = 'line\n# FORGED | `code` [link](https://evil.test) <script>&x';
  const m = manifest([['done', 'done', ['a']]]); m.goal = unsafe; m.tasks[0].title = unsafe; m.tasks[0].note = unsafe; m.checks[0].title = unsafe;
  const value = entry('a'); value.verification.reasons = [unsafe]; value.verification.changes = [{ path: unsafe, kind: 'modified' }];
  const zh = api('renderBrief')(m, [value]);
  assert.ok(!zh.includes(unsafe));
  assert.ok(!zh.includes('\n# FORGED'));
  assert.ok(!zh.includes('[link](https://evil.test)'));
  assert.ok(!zh.includes('`code`'));
  assert.ok(zh.includes('&#124;'));
  assert.ok(zh.includes('&#96;'));
  assert.ok(zh.includes('&lt;script&gt;'));
  const data = api('briefData')(m, [value]);
  assert.equal(data.goal, unsafe); assert.equal(data.tasks[0].note, unsafe); assert.equal(data.checks[0].changes[0].path, unsafe);
  const verify = api('renderVerification')([{ ...value.verification, checkId: unsafe }]);
  assert.ok(!verify.includes(unsafe)); assert.ok(!verify.includes('\n# FORGED'));
});
