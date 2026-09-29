# RepoProof 使用与数据格式

[English README](../README.md) · [中文 README](../README_ZH.md) · [平台支持与验证](VALIDATION.md)

命令帮助是接口入口：`repoproof --help`。收据格式版本为 1，字段由 `src/types.ts` 定义。导入无效 JSON、未知版本、不安全相对路径、矛盾执行状态或摘要不匹配会报告 invalid；核验从不执行 command 字段。

任务清单示例在 `examples/task.json`。检查 ID 是字母或数字开头的 1–64 字符标识，允许字母、数字、点、下划线和短横线。任务的 `checks` 引用检查 ID；`status` 是 `todo`、`done` 或 `blocked`。`done` 是用户声明。

收据保存命令的脱敏参数、时间、执行结果、运行环境版本摘要、执行前后文件快照、有界脱敏输出，以及整体 SHA-256。快照保存 HEAD、scope、相对文件路径和内容摘要，不保存源文件原文。SHA-256 不是数字签名。

`verify --json` 返回数组，每个结果包含 `receiptId`、`checkId`、`execution`、`freshness`、`changes`、`reasons` 和 `verifiedAt`。freshness 是 `unchanged`、`changed`、`unverifiable` 或 `invalid`；execution 是历史 `passed`、`failed`、`incomplete` 或无法读取时的 `unknown`。

`brief --json` 返回 goal、任务、检查与证据边界。检查的 scope 显示执行时的 includeUntracked、固定 exclude 及 untrackedExcluded 数量；没有合法收据时 scope 为 null。任务状态 `evidenced_done` 表示关联历史通过记录与当前文件范围一致；`self_reported_done` 表示只有声明；`needs_recheck` 表示已有检查失败、过期或部分缺失；全部没有记录的 done 仍为自述完成；`todo`、`blocked` 保持任务清单的含义。

相对输入文件路径按调用目录解析；默认数据始终位于 `--cwd` 所属 Git 根目录。输出路径必须在项目内，已有文件不覆盖。需要更新同名简报时可明确使用 shell 重定向，或选择新输出文件名。

首版不提供任意依赖推断、远端状态验证或跨会话自动总结。子模块和不可读路径会显示无法核验；查看 reasons 再决定下一步。

`.repoproof/` 固定排除指当前仓库的根目录；像 `fixtures/.repoproof/example.txt` 这样的已跟踪示例文件仍在检查范围。跨平台收据可以保存 POSIX 文件名；Windows 无法安全解释其中的冒号或反斜杠名称时，核验显示无法核验。
