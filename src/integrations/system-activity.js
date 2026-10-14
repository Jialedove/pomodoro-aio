// 读取“距离上次键盘/鼠标输入的秒数”。macOS 读取 IOHIDSystem 的 HIDIdleTime，覆盖所有 App，
// 不需要辅助功能或输入监控权限；其他平台或读取失败时退回 Obsidian 窗口内的输入事件。
const { parseHidIdleSeconds } = require("../core/time-accounting");

const IOREG_ARGS = ["-c", "IOHIDSystem", "-r", "-d", "1", "-k", "HIDIdleTime"];
const MAX_SYSTEM_FAILURES = 3;
const WINDOW_INPUT_EVENTS = ["keydown", "mousedown", "mousemove", "wheel", "touchstart"];

/** @param {string} command @param {string[]} args @returns {Promise<string>} */
function defaultExecFile(command, args) {
  const { execFile } = require("node:child_process");
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout:2000, windowsHide:true }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}

class SystemActivityMonitor {
  /** @param {{platform?:string, document?:Document|null, execFile?:(command:string,args:string[])=>Promise<string>, now?:()=>number}} [options] */
  constructor({ platform = process.platform, document = null, execFile = defaultExecFile, now = () => Date.now() } = {}) {
    this.platform = platform;
    this.document = document;
    this.execFile = execFile;
    this.now = now;
    this.systemFailures = 0;
    this.lastWindowInputMs = now();
    this._onWindowInput = () => { this.lastWindowInputMs = this.now(); };
    for (const type of WINDOW_INPUT_EVENTS) this.document?.addEventListener(type, this._onWindowInput, { passive:true, capture:true });
  }

  get usesSystemIdle() {
    return this.platform === "darwin" && this.systemFailures < MAX_SYSTEM_FAILURES;
  }

  /** @returns {Promise<number | null>} */
  async readIdleSeconds() {
    if (this.usesSystemIdle) {
      try {
        const seconds = parseHidIdleSeconds(await this.execFile("/usr/sbin/ioreg", IOREG_ARGS));
        if (seconds !== null) {
          this.systemFailures = 0;
          return seconds;
        }
        this.systemFailures += 1;
      } catch (error) {
        this.systemFailures += 1;
        if (!this.usesSystemIdle) console.warn("Pomodoro AIO 无法读取系统空闲时间，改用 Obsidian 窗口内的输入", error);
      }
    }
    if (!this.document) return null;
    return Math.max(0, (this.now() - this.lastWindowInputMs) / 1000);
  }

  /** 把 Obsidian 带到前台；macOS 下窗口 focus() 不会激活被遮住的 App。 */
  async activateObsidian() {
    try { window.focus(); } catch { /* 无窗口环境 */ }
    if (this.platform !== "darwin") return;
    try { await this.execFile("/usr/bin/open", ["-b", "md.obsidian"]); }
    catch (error) { console.warn("Pomodoro AIO 无法将 Obsidian 切到前台", error); }
  }

  dispose() {
    for (const type of WINDOW_INPUT_EVENTS) this.document?.removeEventListener(type, this._onWindowInput, { capture:true });
  }
}

module.exports = { SystemActivityMonitor };
