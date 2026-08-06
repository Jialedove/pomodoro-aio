# Pomodoro AIO 状态机

## 状态模型

运行态由 `status`、`stage`、`mode` 和必要的阶段字段共同表达。状态常量位于 `src/core/timer.js`，启动和恢复时由 `normalizeRuntime` 统一规范化。

所有计时阶段变化统一进入 `src/core/state-machine.js` 的纯 `reduceRuntime(runtime, event)`。reducer 返回新的 runtime 与通用 effects；插件入口只在状态保存成功后执行广播、调度重对齐和强提醒启停。

| 状态 | 含义 | 计时字段约束 |
| --- | --- | --- |
| `idle` | 没有正在进行的阶段 | `stage`、`sessionId`、开始/暂停时间清空 |
| `running` | 专注或休息正在运行 | `stage`、`durationMs`、`startedAtMs` 有效 |
| `paused` | 阶段暂停 | `remainingMs` 有效，`startedAtMs` 清空 |
| `awaiting` | 阶段完成，等待 Ribbon 确认下一段 | `attention` 保存待进入阶段，当前阶段计时清空 |
| `settling` | 专注结算或休息转换正在恢复、推进 | `pendingSettlement` 或 `pendingBreakTransition` 必须存在 |
| `settlement-failed` | 结算失败，保留 session 和失败上下文 | 不丢弃可恢复的 journal |

`stage` 只有 `focus` 和 `break`。循环模式通过 `mode: "cycle"` 与 `cycleSlot` 区分 A/B；循环阶段仍然是专注，不引入第三套计时逻辑。

## 主要转换

```text
idle ──开始专注/循环 A/B──> running(focus)
running ──暂停──> paused
paused ──继续──> running
running(focus) ──到点/手动完成──> settling
settling ──日记/项目/运行态完成──> awaiting 或 running(break)
running(break) ──到点──> awaiting 或 running(focus)
awaiting ──Ribbon 确认──> running
任意可重置状态 ──重置──> idle
```

UI、Ribbon、通知和声音只调用插件的阶段方法；它们不直接拼装运行态。每秒更新只读取绝对时间计算结果，不把 `setTimeout` 的触发时间当作真实计时。

## 旧状态迁移和限制

- `normalizeRuntime` 兼容旧的 `phase`、`pausedLeftSec`、`startedAt`、强提醒字段，并生成缺失的 `sessionId`；插件启动时会把规范化后的运行态重新持久化。
- 当前 schema 为 `3`；不认识的状态、缺少开始时间的运行态和缺少 journal 的结算态会恢复为失败或安全待机状态，而不是继续猜测。
- 运行态保存在 Obsidian local storage；设置保存在插件数据。插件启动时先规范化，再恢复未完成结算、frontmatter 修复队列和项目重试队列。
- 休息本身不产生番茄记录，因此只写轻量的 `pendingBreakTransition`；重载时按其中固定的自动衔接选项和专注时长恢复下一阶段。
