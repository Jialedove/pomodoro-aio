# Pomodoro AIO Agent Guide

## 当前重构上下文

- 本轮模块化重构以 `docs/refactor-target-v1.md` 为目标原文，以 `docs/refactor-context.md` 记录基线、接口约定、进度和验收证据。开始改动和验收前都要对照目标原文。
- 新业务逻辑只围绕工作/休息模块及其执行快照、顺序编排和可选项目关系构建；旧模式字段仅可用于安全迁移。
- 每次完成一个实现范围后更新 `docs/refactor-context.md`，明确自动检查、真实 Obsidian 验证和未完成项。

## 项目边界

- 唯一源码入口：`src/main.js`。
- `main.js` 是 esbuild 生成的 Obsidian 运行产物，禁止直接编辑。
- `manifest.json` 与 `styles.css` 随构建产物一起安装。
- 保持改动小而集中；优先复用现有计时、提醒、日记写入和项目同步逻辑。

## 常用命令

```bash
npm run check
npm run build
npm run install:vault
```

`npm run check` 会执行类型检查、lint、模块序列与可靠性测试，并重新构建 `main.js`。

## 安装到 Dove 的卡片库

插件固定安装到：

```text
/Users/dove/Obsidian_Workspace/Dove的卡片库/.obsidian/plugins/pomodoro-aio
```

只有在用户明确要求安装或验证实际 Obsidian 行为时，才能执行：

```bash
npm run install:vault
```

安装脚本只覆盖：

- `main.js`
- `manifest.json`
- `styles.css`

绝对不要覆盖、删除或重建目标目录中的 `data.json`；其中包含用户设置。安装完成后，需要在 Obsidian 中重载 Pomodoro AIO。若卸载曾失败并残留视图注册，应完全退出并重启 Obsidian一次。

## 修改与验证

- 模块行为变化：检查工作/休息任意排序、循环次数、等待确认与自动衔接，番茄仅由工作产生。
- 可靠性变化：检查每段执行快照、暂停/恢复、日记与项目结算失败后的幂等恢复。
- UI 变化：检查编辑与运行状态、独立项目页，以及窄侧栏布局。
- 卸载逻辑：不要手动 `detach()` 由 Obsidian `Plugin` 生命周期注册的 Ribbon 或视图资源。
- 代码改动后至少运行 `npm run check`。
- 若安装到真实库，最终说明是否只做了自动检查，还是也在 Obsidian 中完成了重载和人工验证。
