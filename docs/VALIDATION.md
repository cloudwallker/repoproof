# Platform support and validation / 平台支持与验证

[English README](../README.md) · [中文 README](../README_ZH.md)

## Requirements and platform scope

Requires Node.js **24.12.0 or later** and Git **2.30 or later**, with no runtime dependencies. Source builds erase TypeScript types and check JavaScript syntax; they do not perform semantic TypeScript checking.

| Platform | Verification scope |
|---|---|
| Windows | Local acceptance covered the CLI, file snapshots, receipts, demo, and offline package workflow. The POSIX colon/backslash filename case is skipped on Windows. |
| macOS and Linux | CI is configured for Node.js 24 and 26. Configuration alone does not establish a successful hosted run. Native POSIX filenames and process behavior require runs on these systems. |

Link tests require permission to create symlinks or directory links. Process-tree cleanup tests require permission to terminate descendants. Restricted environments can skip these cases; inspect the runner's skip reasons. A skipped case is not a passing result.

## Coverage and repeatable checks

Tests cover snapshot scope, tracked and explicitly included untracked files, deletions, Unicode paths, link boundaries, unsupported submodules, real commands, failed/incomplete outcomes, timeouts, interruption, bounded output, and credential redaction.

They also cover receipt structure and integrity, historical execution versus current freshness, changed paths, imported commands that are never executed, task declarations, missing/stale evidence, latest-check selection, bilingual/JSON briefs, safe exports, CLI exit codes, type erasure, module-path rewriting, and the built entry point.

From the source directory:

~~~sh
npm test
npm run build
npm run demo
npm pack
node scripts/smoke-package.mjs ./repoproof-0.1.0.tgz
~~~

The demo uses a disposable Git project, runs a real Node test, and changes `app.mjs` from `answer = 42` to `answer = 43`. It verifies that `execution` remains `passed` while `freshness` becomes `changed`. The smoke check installs the locally created tarball offline and exercises the installed CLI. Generated artifacts stay local and can be regenerated.

## Evidence limits

Passing tests describe the tested behavior and platform, not every possible project or environment. Matching snapshots do not establish unchanged databases, remote services, environment settings, or time conditions. Before/after snapshots can miss temporary changes restored during a command.

SHA-256 detects changes and accidental corruption. Receipts are unsigned; a holder can recompute hashes, so they do not authenticate identity or provide independent provenance. Snapshots store hashes rather than source text; environment metadata records the Node version and platform rather than environment-variable values. Command arguments and output previews can still contain sensitive content. RepoProof itself does not transmit receipts. Redaction is best effort; inspect receipts and briefs before sharing. See the READMEs and [usage notes](usage.md) for file scope and unsupported cases.

## 中文说明

需要 Node.js **24.12.0 或更高版本**和 Git **2.30 或更高版本**，无运行时依赖。构建擦除 TypeScript 类型并检查 JavaScript 语法，不提供语义类型检查。

Windows 已有本地验收覆盖 CLI、文件快照、收据、演示和离线包工作流；创建包含冒号或反斜杠的 POSIX 文件名测试在 Windows 跳过。CI 矩阵配置了 macOS、Linux、Windows 和 Node.js 24、26，配置不代表远端任务已经运行成功。POSIX 文件名与原生进程行为需要在相应系统上验证。文件链接和进程树测试可能受权限限制；查看实际跳过原因，跳过不等于通过。

测试覆盖快照范围与链接边界、真实命令执行与失败/超时/中断、输出限制与凭据脱敏、收据格式及完整性、历史结果与当前状态分离、任务声明及缺失/过期证据、中英文和 JSON 简报、安全导出、退出码与构建入口。上面的命令可重复执行测试、构建、演示、本地打包及离线安装验证。演示在临时 Git 项目中将 `app.mjs` 的 `answer = 42` 改为 `answer = 43`，历史结果仍为 `passed`，当前快照变为 `changed`。生成产物保留在本地，可重新生成。

测试通过只说明被测行为与平台。文件快照相同不证明数据库、远端服务、环境配置和时间条件相同；短暂修改后恢复的内容也可能无法被发现。SHA-256 用于变化与意外损坏检测，收据没有签名、身份认证或独立防伪能力。文件快照保存摘要而非原文，环境元数据仅记录 Node 版本与平台。命令参数及输出摘要仍可能包含敏感内容；RepoProof 自身不传输收据，脱敏只能尽力而为，分享前请检查。文件范围及不支持的情形见 README 和[使用说明](usage.md)。
