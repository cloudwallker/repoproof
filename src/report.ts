import type { Change, Receipt, TaskManifest, Verification } from './types.ts';

type Entry = { receipt: Receipt | null; verification: Verification };
type TaskStatus = 'evidenced_done' | 'self_reported_done' | 'needs_recheck' | 'todo' | 'blocked';
interface CheckSummary {
  id: string; title: string; execution: string; freshness: string;
  receiptId: string | null; reasons: string[]; changes: Change[];
  scope: { includeUntracked: string[]; exclude: string[]; untrackedExcluded: number } | null;
}
interface BriefData {
  schemaVersion: 1; goal: string;
  tasks: { id: string; title: string; declaredStatus: string; status: TaskStatus; note?: string; checks: CheckSummary[] }[];
  checks: CheckSummary[]; limitations: string[];
}

const limitations = {
  zh: [
    '历史执行退出码为 0 不证明检查足够充分，也不保证当前测试通过。',
    '快照内容一致不证明运行环境、数据库、远端服务或时间条件不变。',
    'SHA-256 仅用于变化与意外损坏检测；持有者能重算摘要，收据没有身份认证、签名或独立防伪能力。',
    '自述完成不等于已验证通过；修改后恢复的瞬时变化可能无法识别。',
  ],
  en: [
    'A historical exit code of zero does not prove sufficient check coverage or guarantee that tests pass now.',
    'Matching snapshot content does not prove the environment, database, remote services or time conditions are unchanged.',
    'SHA-256 detects changes and accidental corruption; a holder can recompute it. Receipts have no identity authentication, signature or independent forgery protection.',
    'Self-reported completion is not verified success; transient changes that are reverted may be undetectable.',
  ],
};

function finished(entry: Entry): number {
  return entry.receipt ? Date.parse(entry.receipt.finishedAt) : NaN;
}

function select(entries: Entry[]): Entry | undefined {
  const dated = entries.filter(entry => entry.receipt !== null && Number.isFinite(finished(entry)));
  // Equal finish times prefer the later supplied entry; never prefer passed over failed.
  let latest: Entry | undefined;
  for (const entry of dated) if (!latest || finished(entry) >= finished(latest)) latest = entry;
  // An invalid undated record cannot safely be ordered behind a valid one.
  return entries.findLast(entry => entry.verification.freshness === 'invalid' && !Number.isFinite(finished(entry))) ?? latest ?? entries.at(-1);
}

function summary(id: string, title: string, entry?: Entry, verificationOnly = false): CheckSummary {
  if (!entry || (!verificationOnly && entry.receipt === null && entry.verification.freshness !== 'invalid')) return { id, title, execution: 'unknown', freshness: 'unverifiable', receiptId: null, reasons: ['缺少执行记录 / Missing execution record.'], changes: [], scope: null };
  const value = entry.verification;
  const before = entry.receipt?.before;
  const scope = before ? { includeUntracked: [...before.scope.includeUntracked], exclude: [...before.scope.exclude], untrackedExcluded: before.untrackedExcluded } : null;
  return { id, title, execution: value.execution, freshness: value.freshness, receiptId: value.receiptId || null, reasons: [...value.reasons], changes: value.changes.map(change => ({ ...change })), scope };
}

export function briefData(manifest: TaskManifest, entries: Entry[]): BriefData {
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries) {
    const id = entry.verification.checkId;
    const group = grouped.get(id) ?? [];
    group.push(entry); grouped.set(id, group);
  }
  const checks = manifest.checks.map(check => summary(check.id, check.title, select(grouped.get(check.id) ?? [])));
  const declared = new Set(manifest.checks.map(check => check.id));
  for (const [id, group] of grouped) if (!declared.has(id)) checks.push(summary(id, id, select(group)));
  const byId = new Map(checks.map(check => [check.id, check]));
  const tasks = manifest.tasks.map(task => {
    const taskChecks = task.checks.map(id => byId.get(id) ?? summary(id, id));
    let status: TaskStatus = task.status === 'done' ? 'self_reported_done' : task.status;
    if (task.status === 'done' && taskChecks.length > 0) {
      const hasRecords = task.checks.some(id => grouped.get(id)?.some(entry => entry.receipt !== null || entry.verification.freshness === 'invalid'));
      if (hasRecords) status = taskChecks.every(check => check.execution === 'passed' && check.freshness === 'unchanged') ? 'evidenced_done' : 'needs_recheck';
    }
    return { id: task.id, title: task.title, declaredStatus: task.status, status, ...(task.note === undefined ? {} : { note: task.note }), checks: taskChecks };
  });
  // Keep invalid historical entries visible even when a newer valid record is selected.
  for (const [id, group] of grouped) {
    const selected = select(group);
    for (const entry of group) if (entry !== selected && entry.verification.freshness === 'invalid') checks.push(summary(id, byId.get(id)?.title ?? id, entry));
  }
  return { schemaVersion: 1, goal: manifest.goal, tasks, checks, limitations: [...limitations.zh] };
}

function escape(value: string): string {
  return value.replace(/[&<>\\|`\[\]()!#*_~:+\r\n\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, character => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029') return ' ⏎ ';
    return `&#${character.codePointAt(0)};`;
  });
}

function boundaries(lang: 'zh' | 'en'): string[] {
  return [`## ${lang === 'zh' ? '证据边界' : 'Evidence limits'}`, '', ...limitations[lang].map(text => `- ${text}`)];
}

function checkLines(check: CheckSummary, lang: 'zh' | 'en'): string[] {
  const zh = lang === 'zh';
  const lines = [
    `- ${zh ? '检查' : 'Check'}: ${escape(check.title)} (${escape(check.id)})`,
    `  - ${zh ? '历史执行结果' : 'Historical execution'}: ${escape(check.execution)}`,
    `  - ${zh ? '快照状态' : 'Snapshot freshness'}: ${escape(check.freshness)}`,
    `  - ${zh ? '收据' : 'Receipt'}: ${check.receiptId === null ? (zh ? '无' : 'none') : escape(check.receiptId)}`,
  ];
  if (check.scope) {
    lines.push(`  - ${zh ? '执行范围' : 'Recorded scope'}: ${zh ? '所有已跟踪文件' : 'all tracked files'}`);
    lines.push(`  - ${zh ? '额外纳入的未跟踪路径' : 'Included untracked paths'}: ${check.scope.includeUntracked.length ? check.scope.includeUntracked.map(escape).join(', ') : (zh ? '无' : 'none')}`);
    lines.push(`  - ${zh ? '执行时排除的未跟踪文件' : 'Untracked files excluded at execution'}: ${check.scope.untrackedExcluded}`);
    lines.push(`  - ${zh ? '固定排除路径' : 'Fixed excluded paths'}: ${check.scope.exclude.map(escape).join(', ')}`);
  }
  for (const reason of check.reasons) lines.push(`  - ${zh ? '原因' : 'Reason'}: ${escape(reason)}`);
  for (const change of check.changes) lines.push(`  - ${zh ? '变动' : 'Change'}: ${escape(change.kind)} — ${escape(change.path)}`);
  return lines;
}

export function renderVerification(results: Verification[], lang: 'zh' | 'en' = 'zh'): string {
  const zh = lang === 'zh';
  const lines = [`# ${zh ? 'RepoProof 收据核验' : 'RepoProof receipt verification'}`, ''];
  if (!results.length) lines.push(zh ? '没有执行记录。' : 'No execution records.', '');
  for (const value of results) lines.push(...checkLines(summary(value.checkId, value.checkId, { receipt: null, verification: value }, true), lang), '');
  lines.push(...boundaries(lang), '', `## ${zh ? '下一步建议' : 'Next steps'}`, '', zh ? '- 对失败、变化、无效或无法核验的检查，审查原因后显式重新执行；核验不会运行收据中的命令。' : '- Review failed, changed, invalid or unverifiable checks and explicitly rerun them. Verification does not execute receipt commands.', '');
  return lines.join('\n');
}

export function renderBrief(manifest: TaskManifest, entries: Entry[], lang: 'zh' | 'en' = 'zh'): string {
  const data = briefData(manifest, entries);
  const zh = lang === 'zh';
  const statuses: Record<TaskStatus, string> = zh ? {
    evidenced_done: '完成且有执行记录', self_reported_done: '自述完成', needs_recheck: '需要重验', todo: '未完成', blocked: '阻塞',
  } : {
    evidenced_done: 'Completed with execution evidence', self_reported_done: 'Self-reported done', needs_recheck: 'Needs recheck', todo: 'Todo', blocked: 'Blocked',
  };
  const lines = [`# ${zh ? 'RepoProof 进度简报' : 'RepoProof progress brief'}`, '', `${zh ? '目标' : 'Goal'}: ${escape(data.goal)}`, '', `## ${zh ? '任务' : 'Tasks'}`, ''];
  if (!data.tasks.length) lines.push(zh ? '尚无任务。' : 'No tasks declared.', '');
  for (const task of data.tasks) {
    lines.push(`- ${escape(task.title)} (${escape(task.id)}): ${statuses[task.status]}`, `  - ${zh ? '声明状态' : 'Declared status'}: ${escape(task.declaredStatus)}`);
    if (task.note !== undefined) lines.push(`  - ${zh ? '备注' : 'Note'}: ${escape(task.note)}`);
    for (const check of task.checks) lines.push(`  - ${zh ? '关联检查' : 'Associated check'}: ${escape(check.id)} — ${escape(check.execution)} / ${escape(check.freshness)}`);
    lines.push('');
  }
  lines.push(`## ${zh ? '全部检查（含未绑定检查）' : 'All checks (including unbound checks)'}`, '');
  for (const check of data.checks) lines.push(...checkLines(check, lang), '');
  lines.push(`## ${zh ? '历史执行记录' : 'Historical execution records'}`, '');
  for (const entry of entries) lines.push(...checkLines(summary(entry.verification.checkId, entry.verification.checkId, entry), lang), '');
  if (!entries.length) lines.push(zh ? '没有执行记录。' : 'No execution records.', '');
  lines.push(...boundaries(lang), '', `## ${zh ? '下一步建议' : 'Next steps'}`, '');
  if (data.tasks.some(task => task.status === 'needs_recheck') || data.checks.some(check => check.execution !== 'passed' || check.freshness !== 'unchanged')) {
    lines.push(zh ? '- 审查失败、缺失、变动与无效记录，确认检查范围后显式重新执行相关检查。' : '- Review failures, missing records, changes and invalid receipts; confirm scope and explicitly rerun the relevant checks.');
  }
  if (data.tasks.some(task => task.status === 'self_reported_done')) lines.push(zh ? '- 为自述完成的任务关联检查并生成执行记录。' : '- Associate checks with self-reported tasks and record their execution.');
  if (data.tasks.some(task => task.status === 'todo' || task.status === 'blocked')) lines.push(zh ? '- 推进未完成任务，并记录和处理阻塞原因。' : '- Continue todo tasks and document and resolve blocking reasons.');
  lines.push(zh ? '- 如需了解当前测试结果，请显式执行检查；本简报只解释已有历史证据。' : '- Explicitly run checks to learn current test results; this brief only explains existing historical evidence.', '');
  return lines.join('\n');
}
