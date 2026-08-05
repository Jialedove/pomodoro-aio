# 结算可靠性

## 结算顺序

一次专注完成后，`sessionId` 贯穿内存运行态、持久化 journal、日记计划和项目计划：

```text
running
  -> pendingSettlement(prepared)
  -> daily row applied
  -> daily frontmatter applied or repair queued
  -> project applied or retry queued
  -> runtime finalized
  -> pendingSettlement cleared
```

journal 在任何文件写入前以 critical 保存。每一步完成后再次保存，因此插件在步骤之间退出时，下一次加载可以从 `pendingSettlement.status` 继续。

失败记录会保存操作名、`sessionId`、阶段、目标路径、失败步骤和原始错误消息；日志不会写入用户笔记全文。

## 幂等规则

- 日记任务行计划保存原行、目标行和源文本 hash；重试时若目标行已经存在则视为已应用，若用户改动了目标内容则返回冲突，不覆盖用户编辑。
- 日记 frontmatter 汇总从当前任务行重新计算，而不是盲目累加；失败项进入 `frontmatterQueue`，启动时重试。
- 项目计划保存写入前后的数值；目标值已经存在时视为已应用，当前值既不是旧值也不是目标值时报告冲突，失败项进入 `projectQueue`。
- `projectQueue` 按加入顺序处理；同一项目字段的后续计划依赖前项成功后的 `afterValue`，前项失败时后项暂不尝试。
- 若休息阶段已启动但 journal 尚未清理，恢复会核对阶段、时长和计时字段并继续原计时，不重新起算。
- `_completionInFlight` 只负责同一进程内的并发门控；真正的跨重载恢复依赖持久化 `pendingSettlement` 和上述幂等检查。

## 崩溃恢复

插件启动顺序为：加载并规范化设置、加载运行态、恢复 pending settlement、修复日记汇总队列、排空项目重试队列。日记已经写入而运行态尚未完成时，不会再次增加番茄；项目同步失败时不会回滚日记。

## 数据迁移

设置通过 `normalizeSettings` 统一补默认值、校验数字和 `HH:MM`；运行态通过 `normalizeRuntime` 将旧字段转换为 schema `3`。迁移只在加载时进行，未知或互相矛盾的组合回退到安全状态，不删除用户笔记内容。

## 已知限制

- Obsidian 关闭前的最后一次非关键状态保存仍取决于宿主进程是否允许异步队列完成；阶段变化、结算和恢复使用 critical 保存。
- 外部文件编辑无法自动合并；检测到冲突时保留用户内容并等待下一次明确重试。
- 本项目的自动检查覆盖纯函数、故障注入和构建一致性；真实 Obsidian UI 仍需在目标库中手动回归。
