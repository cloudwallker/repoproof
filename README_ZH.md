# RepoProof

### 用于代码交接的本地 Git 检查收据

**把检查命令的执行结果与 Git 文件快照一起记录，代码改变后及时发现过期证据。历史执行结果与当前文件状态分开展示，让接手者知道哪些检查需要重跑。**

[English](README.md) | 中文

[快速开始](#快速开始) · [工作流](#历史结果与当前文件状态) · [命令](#命令) · [文档](#文档)

![记录通过的检查，修改已跟踪文件，再核验：历史结果仍是 passed，当前快照状态变为 changed](docs/images/repoproof-flow.svg)

*基于项目演示的流程示意图，并非运行截图。核验只比较快照，不会重新执行收据中的命令。*

![repoproof](docs/images/cartoon-infographic.png)

## 功能

- 为明确指定的命令记录执行结果与执行前后的 Git 文件快照。
- 发现同一 Git HEAD 下已跟踪文件的变化；未跟踪文件可明确选择纳入。
- 生成中文、英文或 JSON 简报，区分执行证据与自述完成。
- 收据保存在本地，输出摘要有大小限制，并尽力遮盖常见凭据。

## 快速开始


需要 Node.js **24.12.0 或更高版本**以及 Git **2.30 或更高版本**。零运行时依赖，使用过程无需账号或模型 API Key。

克隆源码并构建，无需安装依赖：

```powershell
git clone https://github.com/cloudwallker/repoproof.git
cd repoproof
npm run build
node bin/repoproof.mjs --help
```

### 可选：自制离线安装包

先在源码目录生成本地 TGZ，再将该文件安装到指定目录：

```powershell
npm pack
npm install --prefix ./tools --offline --ignore-scripts ./repoproof-0.1.0.tgz
node ./tools/node_modules/repoproof/bin/repoproof.mjs --help
```

`npm pack` 的 `prepack` 步骤会构建 JavaScript。换一个目录安装时，使用实际生成文件的路径；包内不要求 TypeScript 编译器。这里说明的是本地打包流程，不承诺已有可下载的 Release 附件。

在已有 Git 项目的目录中，通过实际路径调用构建好的 CLI：

```powershell
node <RepoProof目录>/bin/repoproof.mjs init --goal "修复登录问题并交接"
node <RepoProof目录>/bin/repoproof.mjs run --check tests -- node --test
node <RepoProof目录>/bin/repoproof.mjs verify --json
node <RepoProof目录>/bin/repoproof.mjs brief --lang zh
```

将 `<RepoProof目录>` 替换为克隆后的目录，含空格的路径请加引号。后文的简写 `repoproof` 适用于安装包提供了命令入口的情形；直接使用源码时，使用相同的 Node 调用。

`init` 创建 `.repoproof/task.json`。编辑清单中的目标、检查项、任务进度和阻塞说明；已存在的清单不会被覆盖。RepoProof 不替你初始化 Git 或创建提交。

## 历史结果与当前文件状态

昨天测试退出码为 0，今天代码被修改。`verify` 将显示历史执行结果仍是 `passed`，但快照状态已经 `changed`，并列出变动文件。接手者据此决定重新运行检查，旧的通过记录不会被当成当前通过保证。

```powershell
repoproof run --check tests -- node --test
# 修改已跟踪的源文件后
repoproof verify --json
repoproof brief --lang en --output .repoproof/handoff-en.md
```

简报分别展示“完成且有执行记录”“自述完成”“需要重验”“未完成”和“被阻塞”。`done` 是任务清单中的声明；只有关联检查都有通过记录且快照一致时，才显示完成且有执行记录。

## 命令

| 命令 | 作用 |
|---|---|
| `init --goal "目标"` | 创建可编辑任务清单 |
| `run --check ID -- 程序 参数...` | 执行你明确给出的命令并保存收据 |
| `verify [收据.json]` | 核查当前项目状态，不执行收据中的命令 |
| `brief` | 从任务清单和最新检查记录生成交接简报 |

支持 `--cwd <目录>`，可从项目外调用。`verify` 和 `brief` 支持 `--json`；`run --json` 输出收据及相对保存路径。`brief --task <文件>` 使用显式清单，`--lang zh|en` 选择语言，`--output <项目内文件>` 导出简报。导出拒绝覆盖已有文件、Git 内部路径和链接目录。

检查默认超时 **120000ms**，用 `--timeout` 指定 1 至 86400000 的整数毫秒值。超时、中断或程序启动失败会记录 `incomplete`；失败退出码记录 `failed`。stdout/stderr 每种只保存最多 64KiB 的脱敏摘要，超额输出持续排空。

系统拒绝终止进程树时，会尝试通过句柄终止直接子进程，并在收据输出摘要中报告回收失败；受限环境可能需要手动处理后代进程。

程序和参数按数组直接执行，默认不经 shell。需要 shell 管道时，明确指定自己的 shell，例如 `-- powershell -NoProfile -Command "..."`；仅执行你提供的命令。Windows 的批处理入口不能被当成原生 executable；可使用 `-- node --run test` 调用 package.json 的测试脚本。

## 文件范围

已跟踪文件总是纳入内容快照，包括项目配置和锁文件。已删除的已跟踪文件也能被发现。默认未跟踪文件不纳入，报告保留排除数量；使用 `--include` 明确纳入非忽略文件或目录：

```powershell
repoproof run --check tests --include src/new-feature --include test/new-case.mjs -- node --test
```

`--include .` 纳入所有非忽略未跟踪文件。Git ignore 对未跟踪文件生效；`.repoproof/` 固定排除，即使已跟踪也排除，避免收据和简报使自身失效。建议将该目录加入项目 `.gitignore`。

符号链接仅记录链接目标文字，目标内容不在保证范围内；经父目录链接逃逸的文件无法核验。首版子模块会明确标为不支持核验。执行前后快照变化、文件读取失败和损坏收据都不能显示为有效证据。

## 退出码和数据

| 退出码 | 含义 |
|---:|---|
| 0 | 操作成功，纳入的检查记录通过且快照一致 |
| 1 | 历史检查失败、未完成、缺少记录、快照变化或无法核验 |
| 2 | 命令用法、数据格式或文件操作错误，包含损坏收据 |

`init`、帮助和版本正常完成时返回 0。`brief` 的返回码反映检查证据状态，不代表所有任务都已声明完成。机器输出写 stdout，诊断写 stderr。所有收据位于 `.repoproof/receipts/<UUID>.json`；详见[使用与数据格式说明](docs/usage.md)。

## 证据边界与隐私

历史退出码为 0 不证明检查充分。文件快照一致不证明系统环境、数据库、远端服务或时间条件一致；执行中修改后恢复原内容的短暂变化也无法由前后快照发现。

SHA-256 用于变化与意外损坏检测。收据持有者可以重算摘要，收据没有签名、身份认证或独立防伪能力。命令参数和输出会尽力遮盖常见令牌、密码、私钥、URL 凭据、邮箱及个人主目录；任意自然语言秘密不保证能被识别，分享前请检查导出内容。文件快照保存内容摘要而非源文件原文；环境元数据仅记录 Node 版本与平台，不读取环境变量值。命令参数和输出摘要仍可能包含敏感内容。RepoProof 自身不会联网传输记录。

## 开发与演示

```powershell
npm test
npm run build
npm run demo
npm pack
node scripts/smoke-package.mjs ./repoproof-0.1.0.tgz
```

演示在独立临时 Git 项目中运行真实测试、修改文件，然后生成修改前后 JSON 与中英文简报到 `artifacts/demo/`。测试使用独立 Git fixtures，不操作主项目的提交。构建采用 Node 的类型擦除并检查 JavaScript 语法；它不提供 TypeScript 语义类型检查。

最后一步将本地生成的 TGZ 离线安装到临时目录，并验证安装后的完整工作流。CI 配置覆盖 Windows、macOS 和 Linux，使用 Node.js 24、26；测试覆盖与平台边界见[平台支持与验证说明](docs/VALIDATION.md)，配置存在不代表三平台均已运行成功。

## 文档

- [使用与数据格式](docs/usage.md)
- [任务清单示例](examples/task.json)
- [平台支持、测试覆盖与证据边界](docs/VALIDATION.md)
- [更新记录](CHANGELOG.md)

## 贡献与许可

贡献前请运行测试，并为行为变动增加能观察真实结果的回归测试。项目使用 [MIT License](LICENSE)。
