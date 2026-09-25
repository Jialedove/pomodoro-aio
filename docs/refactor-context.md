# Pomodoro AIO 模块化重构上下文

## 长期目标与使用方式

目标原文为 [`refactor-target-v1.md`](refactor-target-v1.md)。每轮改动开始前读目标第 1–3、17–20、27 节；设计具体功能时再读相关章节；验收时逐项复核第 27 节。这里记录实际代码、决策和证据，不以本文件替代目标原文。

## 基线（2026-09-24，开始重构前）

- Git：`main` / `origin/main` 同在 `7ee5457`，工作区无修改。
- `npm run check` 通过：typecheck、lint、103 个 Node 测试、旧循环自检、生产构建与产物一致性。
- 唯一源码入口为 `src/main.js`；根目录 `main.js` 是构建产物。没有安装或重载到真实 Obsidian。
- 设置在插件 `data.json`，运行态在 `pomodoro-aio-runtime` local storage。当前 schema 为 3。
- 核心仍使用 `standard/cycle`、A/B 槽位、长专注和按轮插休；`src/main.js` 包含启动、恢复、结算与 UI 入口，`src/core/state-machine.js` 维护状态转换，`src/core/settlement.js` 生成可恢复 journal。
- `src/ui/pomodoro-view.js` 将普通模式、循环 A/B 与“共同项目”混排；`src/ui/settings-tab.js` 暴露旧模式参数。项目候选和 frontmatter 写入由 `src/services/repositories.js` 提供。
- 可靠性边界：绝对时间计时、critical runtime 持久化、`pendingSettlement`、幂等日记修改、frontmatter 修复和项目失败队列。模块化重构必须延续这些机制。

## 实现契约

- 模块定义放在 `settings.modules`，工作/休息统一为 `{id, type, name, durationMin, blackout, workspaceCommandId?}`；项目关系独立放在 `settings.projectAssignments[moduleId] = projectPath`，一个工作最多一个项目。
- 编排设置为 `loopMode: infinite | once | count`、`loopCount`、`autoAdvance`；运行态保存当前索引、当前手动选择的稳定模块 ID、完成的工作/休息段数和完整循环数。
- 每次开始形成不可变的 `moduleRun` 快照，至少包括模块 ID、类型、名称、时长、黑屏、工作区、项目路径与唯一运行 ID。运行、恢复、结算和提醒只读取快照，不回查已经被编辑的定义。
- 项目开关为 `enableProjects`。关闭后不展示项目视图、不要求项目数据、不执行新的项目同步；历史失败队列的处理要保持安全且不阻断日记。
- 旧字段只用于加载迁移。所有新启动和推进都走同一模块序列，不新增 `standard/cycle`、A/B 或长专注业务分支。

## 本轮分工与进度

- [x] 目标原文入库，盘点当前代码，跑通基线。
- [x] 模块模型、迁移和序列纯函数：`src/core/modules.js`，由 GPT-6 luna high subagent 实现。
- [x] 统一运行态、快照、结算与恢复集成：`src/main.js` 和状态机、黑屏、仓储适配，由主代理集成。
- [x] 侧栏编辑/执行 UI、独立项目 UI 和设置页：`src/ui/pomodoro-view.js`、`src/ui/projects-view.js`、`src/ui/settings-tab.js`、`styles.css`，由 GPT-6 luna high subagent 实现，主代理修正时序与反馈。
- [x] 基于纯函数、真实仓储模拟和故障注入的模块回归与构建检查。
- [x] 根据首轮界面反馈，恢复旧版紧凑计时环和模块行；每个工作模块重新提供当日日记未勾选待办候选、清空、就地完成、可筛选工作区与黑屏操作；项目关系只在独立项目页编辑。
- [x] 根据第二轮反馈，修复“完成”按钮被默认事件守护拦截；移除重复折叠/展开入口；双击“工作／休息”可在待机或等待确认时选择当前模块，选中 ID 跨重排和重载保留。
- [x] 把 `codex/native-blackout-prototype` 合并进模块化 `main`：macOS 原生遮罩按当前 `moduleRun` 快照启动，工作和休息共用服务；失败时回退窗口遮罩，移除旧网页全屏请求。
- [ ] 真实 Obsidian 的窄侧栏、拖动、Ribbon、黑屏、项目视图与恢复人工验收。
- [ ] 如用户明确要求真实 Obsidian 行为验证，再安装、重载并人工验收。

## 验收记录

### 自动检查

- `npm run check`：第二轮界面修正后通过 typecheck、lint、121/121 个 Node 测试、生产构建与产物一致性；`git diff --check` 通过。新增回归覆盖单模块完成事情、日记勾选、工作区/黑屏/项目关系清空、运行中先结算、同名待办拒绝及当前模块选择。
- 原生黑屏合并后 `npm run check` 通过：typecheck、lint、123/123 个 Node 测试、生产构建与产物一致性，macOS 原生助手编译成功。新增测试覆盖工作/休息模块快照、下一模块重新启动、原生失败回退与过期进程消息隔离。
- 临时目录安装模拟通过：`main.js`、`manifest.json`、`styles.css` 和 `bin/pomodoro-blackout` 与仓库产物逐字节一致，助手可执行，临时 `data.json` 保持原内容。该模拟不等于真实 Obsidian 安装或界面验收。
- 新增模块纯函数测试，覆盖旧 standard/cycle/长专注迁移、显式空序列、稳定 ID、项目关系快照和循环次数。
- 新增模块集成测试，覆盖工作/休息结算与分开计数、运行中编辑快照、待确认时修改项目关系、零时长工作、关闭项目、项目写入失败、工作 journal 中断恢复和休息转换中断恢复。
- 原有旧运行态与 journal 回归仍保留，作为升级前未完成阶段的兼容安全网；新的 UI 和命令已经只使用模块入口。

### 目标第 27 节对照

| 条目 | 当前证据与待验收项 |
| --- | --- |
| 1、7、17 统一执行体系和移除旧模式 | 新入口、UI、设置与模块推进只使用模块序列；旧 A/B、长专注状态和方法仍留在兼容恢复分支，供升级前未完成计时/journal 使用。需要真实升级场景验证后再收缩适配器。 |
| 2、4、5、6、8、9、10 自由编排与简洁执行 | 代码已实现增删改、拖动排序、工作区、黑屏、循环次数与自动/手动衔接；旧按轮插休不参与新执行。尚待 Obsidian 窄侧栏和操作验收。 |
| 3、11 工作/休息/循环统计分离 | 模块集成测试验证工作 30 分钟为 `1.2🍅`、休息 0 番茄、段数与完整循环分别计数。 |
| 12–15 项目独立且可关闭 | 独立项目视图与单项目关联已实现；关闭时不访问项目仓储的集成测试通过。尚待真实项目页显示与交互验收。 |
| 16 项目失败不破坏日记 | 新模块项目写入失败故障注入通过：日记保留、重试项保留。 |
| 18 可靠性机制 | 保留旧回归，新增新模块工作 journal 与休息转换跨持久化恢复测试；真实 Obsidian 重载和故障场景未执行。 |

### 安装与人工验收

本次合并未运行 `npm run install:vault`，未重载 Obsidian，未做真人界面验收；目标库 `data.json` 未触碰。原生助手已本地编译，但真实多显示器、Esc/退出按钮、休眠唤醒等行为仍需按手动清单验证。
本轮尝试在应用浏览器打开本地静态窄侧栏预览，被浏览器 URL 策略拒绝；没有用其他浏览器或转发方式绕过。CSS 与 DOM 已做静态核对，仍需真实 Obsidian 视觉验收。

## 当前决策与风险

- 首次缺少 `modules` 字段时迁移旧配置；显式 `modules: []` 是用户空序列，不重新迁移。旧标准专注映射工作/休息，旧长专注成为普通工作，旧 A/B 及按轮休息展开为线性列表。
- 当前工作快照在真正开始时冻结。等待确认期间可修改模块定义和项目关系；已经运行的段不受修改影响。
- 关闭项目功能后跳过新项目计划、项目候选和重试队列；已持久化 journal 的未执行项目步骤可安全跳过。重新启用后可继续旧失败队列。
- 现有兼容恢复方法仍在源码中，避免升级中丢失进行中的旧计时或 pending journal。新产品入口均不调用它们；这部分应在真实迁移验证后考虑移除。
- 项目累计番茄在独立视图从 Obsidian metadata cache 读取，可能短暂落后于刚写入的 frontmatter；真实界面验收需特别检查刷新时序。
- 界面反馈明确要求延续原侧栏的信息密度和单段工作操作。模块编辑区不显示项目字段；项目页负责建立或解除关系。原版从日记选择未勾选待办和完成事情的操作须保留在每个工作模块上。
- 完成按钮失效的根因是按钮先 `preventDefault()`，随后将同一事件传入 `runUserCommand`，后者把 `defaultPrevented` 当作拦截信号。修正为按下时仅阻止失焦、在独立 click 事件中执行命令。
- 当前模块选择仅允许待机或等待下一段时改变；运行中的快照不可被双击覆盖。结束完整序列或重置后，下一次默认回到第一项。
- 原生黑屏助手源码在 `native/BlackoutOverlay.swift`，构建脚本在 `scripts/build-native.mjs`，桥接在 `src/ui/native-blackout.js`。`npm run install:vault` 在 macOS 上额外复制 `bin/pomodoro-blackout`，仍保留 `data.json`；未安装助手或运行失败时退回 Obsidian 窗口遮罩。
