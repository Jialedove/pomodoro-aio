# Pomodoro AIO

一款独立运行的 Obsidian 番茄钟插件，支持普通番茄钟、双任务循环工作、日记番茄统计，以及项目文件 frontmatter 同步。

## 功能

- 普通番茄钟：专注、短休息和长休息自动衔接。
- 循环模式：在 A、B 两项任务间交替专注，不插入休息阶段。
- 任务与日记：将番茄数写入任务行，并汇总当天完成量。
- 项目同步：同步项目文件的 frontmatter 信息。

## 开发

需要 Node.js 与 npm。

```bash
npm install
npm run check
```

日常开发只编辑 `src/main.js`；`main.js` 是构建产物，请勿直接修改。

```bash
npm run build
```

## 安装到本地 Obsidian 库

```bash
OBSIDIAN_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/pomodoro-aio" npm run install:vault
```

安装脚本仅覆盖插件的 `main.js`、`manifest.json` 与 `styles.css`，会保留已有的 `data.json` 设置文件。安装后请在 Obsidian 中重载插件。

## 许可证

[MIT License](LICENSE)
