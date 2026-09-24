# Pomodoro AIO

一款独立运行的 Obsidian 番茄钟插件，支持普通番茄钟、双任务循环工作、日记番茄统计、快速记录，以及项目文件 frontmatter 同步。改造重点是计时准确、记录幂等和异常可恢复。

## 运行行为

- 普通模式：专注结束后按设置进入短休/长休；关闭自动衔接时由 Ribbon 确认开始下一段。
- 循环模式：任务 A、B 交替专注；默认每段结束后由 Ribbon 确认下一项，也可设置“完成多少轮后提示短休”，达到完整 A→B 轮数后等待用户点击开始短休，休息结束再确认下一段 A。
- 暂停、继续和重置均以毫秒运行态计算，恢复时根据绝对时间重新计算剩余时间。
- 自然到点按计划时长折算番茄；“立刻结算当前专注”按实际有效专注时长折算，均保持一位小数，非零实际时长最低记为 `0.1🍅`。
- 强提醒只提醒待确认阶段，不会重新启动已经运行的阶段。
- 可选“休息时黑屏”和逐任务“执行时黑屏”在 macOS 上使用无边框原生覆盖层，遮住鼠标所在显示器的当前画面，不会把 Obsidian 切到新的全屏空间；Esc 或“立即退出”只撤下遮罩，不停止计时。原生程序不可用时退回 Obsidian 窗口内遮罩并提示原因。
- “完成本段”只结算当前专注；“完成任务”会先结算正在运行任务的实际时长，再勾选对应日记待办，并清空该任务及其 Workspaces Plus 选择。

## 日记与项目同步

- 日记按逻辑日期和路径模板定位；任务行精确匹配，找不到时仅在开启自动创建后插入。
- 任务行写入和当天 frontmatter 汇总使用 Obsidian 原子处理，并保留原有复选框、缩进和换行格式。
- 项目 frontmatter 在日记结算之后同步；项目文件缺失、外部修改或写入失败不会回滚日记，会保留可重试队列。
- 设置和兼容迁移数据由 Obsidian 插件数据保存；运行态使用 `pomodoro-aio-runtime` 本地存储键。安装脚本不会覆盖插件目录中的 `data.json`。
- 侧栏“刷新”右侧的“快速捕捉”会展开输入框，按 Enter 将内容原子追加为待办；命令“快速记录”仍可选择待办或想法。目标默认是当日日记的 `Inbox`，可在设置中改为按日期模板定位的 Markdown 文件。
- 在日记中外部勾选某个已选择任务时，插件会清空对应的普通任务或循环 A/B 任务选择。存在多条同名未完成待办时，插件不会猜测要勾选哪一条。

## 开发

需要 Node.js LTS、npm，以及 Obsidian 1.8.7 或更高版本。macOS 原生黑屏还需要 Xcode Command Line Tools 中的 Swift 编译器。

```bash
npm ci
npm run dev
```

`npm run dev` 监听源码并生成开发构建。日常开发只编辑 `src/main.js` 及其模块；根目录 `main.js` 是构建产物，请勿直接修改。

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run check
```

`npm run typecheck` 会执行全部源码语法检查，并对全部 `src` 模块运行 TypeScript `checkJs`；`types/obsidian.d.ts` 只提供编译期 API 形状，不进入运行时。`npm run check` 依次执行类型检查、项目 lint、单元/集成测试、生产构建、构建产物一致性检查和 macOS 原生辅助程序构建（非 macOS 跳过）。

CI 还会确认提交的根目录 `main.js` 与生产构建一致；源码改动后请提交重新生成的产物。

真实 Obsidian 回归步骤见 [`docs/manual-regression.md`](docs/manual-regression.md)。

发布构建使用：

```bash
npm run build
```

构建保持 `obsidian` 为 external，输出 CommonJS、ES2020 兼容的压缩 `main.js`。

## 安装到本地 Obsidian 库

```bash
npm run install:vault
```

默认安装到 Dove 的卡片库；如需临时指定其他目录，可设置 `OBSIDIAN_PLUGIN_DIR`。安装脚本只覆盖插件的 `main.js`、`manifest.json`、`styles.css` 与 `bin/pomodoro-blackout`，保留已有的 `data.json` 设置文件。安装后请在 Obsidian 中重载插件。原生程序只接收当前任务的显示文字与倒计时，计时与日记写入仍由插件管理；失去插件输入后会自动退出。

## 许可证

[MIT License](LICENSE)
