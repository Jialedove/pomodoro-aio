# Pomodoro AIO

一款独立运行的 Obsidian 番茄钟插件，支持普通番茄钟、双任务循环工作、日记番茄统计、快速记录，以及项目文件 frontmatter 同步。改造重点是计时准确、记录幂等和异常可恢复。

## 运行行为

- 普通模式：专注结束后按设置进入短休/长休；关闭自动衔接时由 Ribbon 确认开始下一段。
- 循环模式：任务 A、B 交替专注；默认每段结束后由 Ribbon 确认下一项，也可设置“完成多少轮后提示短休”，达到完整 A→B 轮数后等待用户点击开始短休，休息结束再确认下一段 A。
- 暂停、继续和重置均以毫秒运行态计算，恢复时根据绝对时间重新计算剩余时间。
- 自然到点按计划时长折算番茄；“立刻结算当前专注”按实际有效专注时长折算，均保持一位小数，非零实际时长最低记为 `0.1🍅`。
- 强提醒只提醒待确认阶段，不会重新启动已经运行的阶段。
- 可选“休息时黑屏”会在休息真正开始后遮住 Obsidian 主窗口；Esc 或点击只退出遮罩，不会停止休息计时。

## 日记与项目同步

- 日记按逻辑日期和路径模板定位；任务行精确匹配，找不到时仅在开启自动创建后插入。
- 任务行写入和当天 frontmatter 汇总使用 Obsidian 原子处理，并保留原有复选框、缩进和换行格式。
- 项目 frontmatter 在日记结算之后同步；项目文件缺失、外部修改或写入失败不会回滚日记，会保留可重试队列。
- 设置和兼容迁移数据由 Obsidian 插件数据保存；运行态使用 `pomodoro-aio-runtime` 本地存储键。安装脚本不会覆盖插件目录中的 `data.json`。
- 侧栏或“快速记录”命令可以把待办与想法原子追加到当日日记的 `Inbox` 区域；区域标题可在设置中修改。

## 开发

需要 Node.js LTS、npm，以及 Obsidian 1.8.7 或更高版本。

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

`npm run typecheck` 会执行全部源码语法检查，并对全部 `src` 模块运行 TypeScript `checkJs`；`types/obsidian.d.ts` 只提供编译期 API 形状，不进入运行时。`npm run check` 依次执行类型检查、项目 lint、单元/集成测试、生产构建和构建产物一致性检查。

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

默认安装到 Dove 的卡片库；如需临时指定其他目录，可设置 `OBSIDIAN_PLUGIN_DIR`。安装脚本仅覆盖插件的 `main.js`、`manifest.json` 与 `styles.css`，会保留已有的 `data.json` 设置文件。安装后请在 Obsidian 中重载插件。

## 许可证

[MIT License](LICENSE)
