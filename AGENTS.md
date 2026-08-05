# Pomodoro AIO Agent Guide

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

`npm run check` 会执行语法检查、循环模式自检并重新构建 `main.js`。

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

- 普通模式行为变化：检查单任务、短休、长休、自动进入下一段。
- 循环模式行为变化：检查 A/B 任务交替、无休息阶段、Ribbon 确认、分钟数按 `分钟 / 25` 折算番茄。
- UI 变化：同时检查普通与循环两套界面，以及窄侧栏布局。
- 卸载逻辑：不要手动 `detach()` 由 Obsidian `Plugin` 生命周期注册的 Ribbon 或视图资源。
- 代码改动后至少运行 `npm run check`。
- 若安装到真实库，最终说明是否只做了自动检查，还是也在 Obsidian 中完成了重载和人工验证。
