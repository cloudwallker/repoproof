import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Receipt, Verification } from './types.ts';

const HELP = `RepoProof 0.1.0 — 本地检查收据与代码交接

用法：
  repoproof init --goal "项目目标" [--cwd 目录]
  repoproof run --check tests [--include 相对路径] [--timeout 毫秒] -- 程序 参数...
  repoproof verify [收据.json] [--cwd 目录] [--json]
  repoproof brief [--task 清单.json] [--lang zh|en] [--json] [--output 相对文件]
  repoproof --help | --version

run 也支持 --cwd、--json；默认超时 120000ms。run 仅执行 -- 后明确给出的命令。
所有操作使用已有 Git 项目；不会创建提交。verify/brief 只读且不执行导入命令。
退出码：0 可用；1 历史失败/未完成/需重验；2 输入或记录无效。
快照一致不表示当前测试保证通过。详见 README。
`;

class CliError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}
interface Options {
  action: string; cwd: string; check?: string; goal?: string; timeout: number;
  include: string[]; json: boolean; lang: 'zh' | 'en'; task?: string;
  output?: string; positionals: string[]; command: string[];
}

function parse(args: string[]): Options {
  const action = args[0] ?? '--help';
  if (action === '--help' || action === '-h' || action === '--version' || action === '-v') {
    if (args.length > 1) throw new CliError('帮助和版本选项不接受其他参数。');
    return { action, cwd: process.cwd(), timeout: 120000, include: [], json: false, lang: 'zh', positionals: [], command: [] };
  }
  const allowed: Record<string, Set<string>> = {
    init: new Set(['--cwd', '--goal']),
    run: new Set(['--cwd', '--check', '--timeout', '--include', '--json']),
    verify: new Set(['--cwd', '--json']),
    brief: new Set(['--cwd', '--task', '--lang', '--json', '--output']),
  };
  if (!allowed[action]) throw new CliError('未知命令。运行 repoproof --help 查看用法。');
  const options: Options = { action, cwd: process.cwd(), timeout: 120000, include: [], json: false, lang: 'zh', positionals: [], command: [] };
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      if (action !== 'run') throw new CliError('只有 run 接受 -- 后的执行命令。');
      options.command = args.slice(i + 1);
      break;
    }
    if (!arg.startsWith('-')) { options.positionals.push(arg); continue; }
    if (!allowed[action].has(arg)) throw new CliError('未知或不适用的选项。运行 repoproof --help 查看用法。');
    if (seen.has(arg) && arg !== '--include') throw new CliError('同一选项只能提供一次。');
    seen.add(arg);
    if (arg === '--json') { options.json = true; continue; }
    const value = args[++i];
    if (value === undefined || value === '--' || !value.length) throw new CliError('选项缺少值。');
    if (arg === '--cwd') options.cwd = resolve(value);
    if (arg === '--goal') options.goal = value;
    if (arg === '--check') options.check = value;
    if (arg === '--task') options.task = value;
    if (arg === '--output') options.output = value;
    if (arg === '--include') options.include.push(value);
    if (arg === '--timeout') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 86400000) {
        throw new CliError('超时必须是 1 至 86400000 的整数毫秒值。');
      }
      options.timeout = Number(value);
    }
    if (arg === '--lang') {
      if (value !== 'zh' && value !== 'en') throw new CliError('语言必须是 zh 或 en。');
      options.lang = value;
    }
  }
  if (options.positionals.length > (action === 'verify' ? 1 : 0)) throw new CliError('多余的位置参数。执行命令必须放在 run 的 -- 后。');
  if (options.include.length > 1000) throw new CliError('纳入路径数量超出上限。');
  if (action === 'init' && (!options.goal?.trim() || options.goal.length > 10000)) throw new CliError('init 需要非空 --goal，最多 10000 字符。');
  if (action === 'run') {
    if (!options.check || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.check)) throw new CliError('run 需要合法的 --check ID。');
    if (!options.command.length || !options.command[0]?.trim()) throw new CliError('run 需要 -- 后的程序及参数，例如 -- node --test。');
  }
  return options;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

async function projectPath(root: string, path: string, createParents = false): Promise<string> {
  const target = resolve(root, path);
  if (!inside(root, target) || target === root) throw new CliError('输出路径必须是项目内的文件。');
  const rel = relative(root, target);
  if (rel.split(sep).some(part => part.toLowerCase() === '.git')) throw new CliError('不能读写 Git 内部路径。');
  const parts = relative(root, dirname(target)).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let entry;
    try { entry = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !createParents) throw new CliError('项目数据目录不存在或无法读取。', (error as NodeJS.ErrnoException).code);
      await mkdir(current);
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory() || !inside(root, await realpath(current))) {
      throw new CliError('项目数据路径包含链接或越界目录。');
    }
  }
  try { if ((await lstat(target)).isSymbolicLink()) throw new CliError('不能通过符号链接读写项目数据。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return target;
}

type Entry = { receipt: Receipt | null; verification: Verification };
function invalid(reason: string): Entry {
  return { receipt: null, verification: { receiptId: 'unknown', checkId: 'unknown', execution: 'unknown', freshness: 'invalid', changes: [], reasons: [reason], verifiedAt: new Date().toISOString() } };
}

async function readEntry(path: string, root: string): Promise<Entry> {
  const { verifyReceipt, validateReceipt } = await import('./verifier.ts');
  let input: unknown;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) return invalid('收据必须是最大 64MiB 的普通 JSON 文件。');
    input = JSON.parse(await readFile(path, 'utf8'));
  } catch { return invalid('无法读取或解析收据 JSON。'); }
  const verification = await verifyReceipt(input, root);
  let receipt: Receipt | null = null;
  try { receipt = validateReceipt(input); } catch { /* Invalid records remain visible. */ }
  return { receipt, verification };
}

async function entriesFor(root: string, explicit?: string): Promise<Entry[]> {
  if (explicit) return [await readEntry(resolve(explicit), root)];
  let directory: string;
  let names: string[];
  try {
    directory = await projectPath(root, '.repoproof/receipts/index.json');
    names = (await readdir(dirname(directory))).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new CliError('无法读取收据目录。检查目录权限和链接。');
  }
  if (names.length > 10000) throw new CliError('收据过多，请用 verify 指定单个文件。');
  const result: Entry[] = [];
  for (const name of names) result.push(await readEntry(join(dirname(directory), name), root));
  return result;
}

function statusCode(results: Verification[]): number {
  if (!results.length) return 1;
  if (results.some(result => result.freshness === 'invalid')) return 2;
  return results.every(result => result.execution === 'passed' && result.freshness === 'unchanged') ? 0 : 1;
}

export async function main(args: string[]): Promise<number> {
  let root: string | undefined;
  try {
    const options = parse(args);
    if (options.action === '--help' || options.action === '-h') { process.stdout.write(HELP); return 0; }
    if (options.action === '--version' || options.action === '-v') { process.stdout.write('0.1.0\n'); return 0; }
    const { resolveRepoRoot } = await import('./snapshot.ts');
    root = resolveRepoRoot(options.cwd);
    if (options.action === 'init') {
      const path = await projectPath(root, '.repoproof/task.json', true);
      const manifest = { schemaVersion: 1, goal: options.goal, checks: [{ id: 'tests', title: '项目测试 / Project tests' }], tasks: [{ id: 'task-1', title: '完成项目目标 / Complete project goal', status: 'todo', checks: ['tests'] }] };
      try { await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('任务清单已存在。请编辑 .repoproof/task.json，不会覆盖。');
        throw new CliError('无法写入任务清单。检查目录权限。');
      }
      process.stdout.write('已创建 .repoproof/task.json。编辑目标、任务和检查项后使用 run。\n');
      return 0;
    }
    if (options.action === 'run') {
      const { runCheck } = await import('./recorder.ts');
      const { receipt, receiptPath } = await runCheck({ cwd: root, checkId: options.check!, command: options.command, includeUntracked: options.include, timeoutMs: options.timeout });
      if (options.json) process.stdout.write(JSON.stringify({ receipt, receiptPath: relative(root, receiptPath).split(sep).join('/') }, null, 2) + '\n');
      else {
        process.stdout.write(`检查 ${receipt.checkId}: ${receipt.execution.status}\n收据: ${relative(root, receiptPath).split(sep).join('/')}\n`);
        if (receipt.output.stdout) process.stdout.write(stripVTControlCharacters(receipt.output.stdout) + '\n');
        if (receipt.output.stderr) process.stderr.write(stripVTControlCharacters(receipt.output.stderr) + '\n');
      }
      if (receipt.execution.status !== 'passed') return 1;
      return receipt.after && !receipt.before.issues.length && !receipt.after.issues.length && receipt.before.digest === receipt.after.digest ? 0 : 1;
    }
    const entries = await entriesFor(root, options.positionals[0]);
    const results = entries.map(entry => entry.verification);
    const { renderVerification, renderBrief, briefData } = await import('./report.ts');
    if (options.action === 'verify') {
      process.stdout.write(options.json ? JSON.stringify(results, null, 2) + '\n' : renderVerification(results, options.lang) + '\n');
      return statusCode(results);
    }
    const { loadManifest } = await import('./manifest.ts');
    const taskPath = options.task ? resolve(options.task) : await projectPath(root, '.repoproof/task.json');
    const manifest = await loadManifest(taskPath);
    const data = briefData(manifest, entries);
    const content = options.json ? JSON.stringify(data, null, 2) + '\n' : renderBrief(manifest, entries, options.lang) + '\n';
    if (options.output) {
      if (relative(root, resolve(root, options.output)).split(sep).slice(0, 2).join('/').toLowerCase() === '.repoproof/receipts') throw new CliError('简报不能写入收据目录。');
      const target = await projectPath(root, options.output, true);
      try { await writeFile(target, content, { flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('输出文件已存在。请选择新文件名，或通过 stdout 重定向自行覆盖。');
        throw new CliError('无法保存简报。检查输出权限。');
      }
      if (!options.json) process.stdout.write(`已保存 ${relative(root, target).split(sep).join('/')}\n`);
      else process.stdout.write(content);
    } else process.stdout.write(content);
    if (results.some(result => result.freshness === 'invalid')) return 2;
    return data.checks.every(check => check.execution === 'passed' && check.freshness === 'unchanged') ? 0 : 1;
  } catch (error) {
    let diagnostic = error instanceof CliError ? error.message : '操作失败。检查 Git 环境、数据格式及文件权限。';
    try {
      const { redactText } = await import('./redact.ts');
      diagnostic = redactText(diagnostic, root);
    } catch { /* Error output must not depend on optional diagnostics. */ }
    process.stderr.write(`RepoProof: ${stripVTControlCharacters(diagnostic)}\n`);
    return 2;
  }
}
