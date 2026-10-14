// 安装、卸载或查看 pomodoro-guard LaunchAgent（macOS）。
// 用法：node scripts/guard.mjs install|uninstall|status
import { chmod, copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "com.pomodoro-aio.guard";

/** @param {string} value */
function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** @param {{binary:string, logPath:string, args?:string[]}} options */
export function buildPlist({ binary, logPath, args = [] }) {
  const program = [binary, ...args].map(item => `    <string>${xml(item)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

/** @param {string} home */
export function guardPaths(home = os.homedir()) {
  return {
    binary:path.join(home, "Library", "Application Support", "pomodoro-aio", "pomodoro-guard"),
    plist:path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    logPath:path.join(home, "Library", "Logs", "pomodoro-aio-guard.log")
  };
}

/** @param {string[]} args */
function launchctl(args) {
  return spawnSync("launchctl", args, { encoding:"utf8" });
}

async function install() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = path.join(root, "bin", "pomodoro-guard");
  const paths = guardPaths();
  const domain = `gui/${process.getuid()}`;
  await mkdir(path.dirname(paths.binary), { recursive:true });
  await mkdir(path.dirname(paths.plist), { recursive:true });
  await mkdir(path.dirname(paths.logPath), { recursive:true });
  launchctl(["bootout", domain, paths.plist]);
  const temporary = `${paths.binary}.installing`;
  await copyFile(source, temporary);
  await chmod(temporary, 0o755);
  await rename(temporary, paths.binary);
  await writeFile(paths.plist, buildPlist({ binary:paths.binary, logPath:paths.logPath }));
  const result = launchctl(["bootstrap", domain, paths.plist]);
  if (result.status !== 0) throw new Error(`launchctl bootstrap 失败：${result.stderr || result.stdout}`);
  console.log(`已安装并启动 ${LABEL}`);
  console.log(`程序：${paths.binary}\n配置：${paths.plist}\n日志：${paths.logPath}`);
}

async function uninstall() {
  const paths = guardPaths();
  launchctl(["bootout", `gui/${process.getuid()}`, paths.plist]);
  await rm(paths.plist, { force:true });
  await rm(paths.binary, { force:true });
  console.log(`已停止并移除 ${LABEL}（日志保留在 ${paths.logPath}）`);
}

function status() {
  const paths = guardPaths();
  const result = launchctl(["print", `gui/${process.getuid()}/${LABEL}`]);
  if (result.status !== 0) {
    console.log(`${LABEL} 未加载`);
    return;
  }
  const state = /state = (\S+)/.exec(result.stdout)?.[1] || "unknown";
  const pid = /pid = (\d+)/.exec(result.stdout)?.[1] || "-";
  console.log(`${LABEL}：${state}（pid ${pid}）`);
  const probe = spawnSync(paths.binary, ["--status"], { encoding:"utf8" });
  if (probe.stdout) console.log(probe.stdout.trim());
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.platform !== "darwin") {
    console.log("pomodoro-guard 仅支持 macOS。");
    process.exit(0);
  }
  const command = process.argv[2];
  if (command === "install") await install();
  else if (command === "uninstall") await uninstall();
  else if (command === "status") status();
  else {
    console.error("用法：node scripts/guard.mjs install|uninstall|status");
    process.exit(1);
  }
}
