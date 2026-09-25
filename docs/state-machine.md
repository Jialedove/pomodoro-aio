# Pomodoro AIO 模块状态机

## 运行模型

配置中的 `settings.modules` 是可编辑的模块定义。每次执行时生成 `runtime.moduleRun`：固定模块 ID、运行 ID、类型、名称、时长、黑屏、工作区及开始时的项目关系。定义修改只影响以后开始的模块。`currentModuleIndex` 记录序列位置；`completedWorkCount`、`completedRestCount`、`completedLoopCount` 分别计数。序列推进由 `src/core/modules.js` 计算，不依赖 A/B 槽位或旧工作模式。

工作映射到计时内核的 `focus` 阶段，休息映射到 `break` 阶段。两者都使用绝对时间、暂停/恢复、到点提醒和重载恢复；只有工作写番茄。状态转换集中在 `src/core/state-machine.js` 的 `reduceRuntime`，并在关键持久化成功后才执行 UI 和调度效果。

| 状态 | 含义 |
| --- | --- |
| `idle` | 序列尚未开始或已经结束；可保留本次完成计数 |
| `running` | 一个模块正在计时，`moduleRun` 和绝对开始时间有效 |
| `paused` | 当前模块暂停，保存已用和剩余毫秒 |
| `awaiting` | 下一模块等待确认；`attention.moduleRun` 保存待启动计划 |
| `settling` | 工作 journal 或模块转换正在持久化和推进 |
| `settlement-failed` | 保留 journal/转换和失败上下文，等待重载恢复 |

## 转换

```text
idle → startSequence → running(工作或休息)
running ↔ paused
running(工作) → pendingSettlement → 下一模块 running/awaiting，或 idle
running(休息) → pendingBreakTransition → 下一模块 running/awaiting，或 idle
awaiting → 确认 → 新 moduleRun → running
```

末项完成时完整循环数加一，再按 `loopMode`（无限、一次、指定次数）决定从头开始或停止。`autoAdvance` 决定下一模块自动开始还是等待确认。待确认期间编辑定义或项目关系后，真正启动时以最新定义重新生成运行快照；已有运行段仍保持原快照。

“完成本段”在工作中按实际有效时长结算；零有效时长只推进序列、不写日记番茄。休息完成不写日记，也不增加工作次数。两类无日记写入的转换通过持久化转换记录恢复，防止重载后重复计数或重复开始下一段。

## 旧数据兼容

当前 runtime schema 为 `4`。旧设置只在首次缺少 `modules` 字段时转换；显式空列表不再触发旧迁移。旧 `standard/cycle`、A/B、长专注和按轮插休字段仅供迁移旧配置或恢复升级前仍在执行的阶段与 journal。新 UI、命令和 `startSequence` 路径只运行模块序列。旧待结算记录先按原计划完成，再进入新序列。
