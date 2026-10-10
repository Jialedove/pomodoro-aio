const { BreakBlackoutController, blackoutKey, blackoutPrompt, shouldShowBlackout } = require("./break-blackout");

// Node APIs are intentionally loaded only on macOS desktop. Obsidian does not
// expose Electron's main process to community plugins.
/** @param {string} binaryPath */
function defaultSpawn(binaryPath) {
  const { spawn } = require("node:child_process");
  return spawn(binaryPath, [], { shell:false, stdio:["pipe", "pipe", "pipe"] });
}

// The helper can still exit for reasons outside the plugin (killed, crashed).
// Restart it a few times per blackout segment before using the window overlay.
const MAX_NATIVE_RESTARTS = 3;

class NativeBlackoutController {
  /** @param {{document:Document, binaryPath:string, spawnProcess?:(path:string)=>any, onUnavailable?:(reason:string)=>void, now?:()=>number}} options */
  constructor({ document, binaryPath, spawnProcess=defaultSpawn, onUnavailable=()=>{}, now=()=>Date.now() }) {
    this.binaryPath = binaryPath;
    this.spawnProcess = spawnProcess;
    this.onUnavailable = onUnavailable;
    this.now = now;
    this.fallback = new BreakBlackoutController({ document, now });
    this.child = null;
    this.childOutput = "";
    this.currentKey = "";
    this.dismissedKey = "";
    this.failedKey = "";
    this.finishedKey = "";
    this.finishUntilMs = 0;
    this.runtime = null;
    this.settings = null;
    this.leftSec = 0;
    this.syncedAtMs = 0;
    this.restartCount = 0;
    this.destroyed = false;
  }

  /** @param {Record<string, any>} message */
  _send(message) {
    if (!this.child?.stdin?.writable) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  _stop() {
    const child = this.child;
    this.child = null;
    this.childOutput = "";
    if (!child) return;
    try { child.stdin.write('{"type":"hide"}\n'); } catch { /* process may already be gone */ }
    try { child.stdin.end(); } catch { /* process may already be gone */ }
    const timeout = setTimeout(() => {
      if (child.exitCode == null) child.kill();
    }, 1000);
    /** @type {any} */ (timeout).unref?.();
  }

  /** @param {string} key @param {string} reason */
  _fail(key, reason) {
    if (this.destroyed || this.currentKey !== key || this.failedKey === key) return;
    this.failedKey = key;
    this._stop();
    this.onUnavailable(reason);
    if (this.runtime && this.settings) this.fallback.sync(this.runtime, this.settings, this.leftSec);
  }

  /** @param {unknown} chunk @param {string} key @param {any} child */
  _receive(chunk, key, child) {
    if (this.child !== child) return;
    this.childOutput += String(chunk);
    if (this.childOutput.length > 8192) {
      this._fail(key, "原生黑屏返回了无效响应");
      return;
    }
    while (this.childOutput.includes("\n")) {
      const split = this.childOutput.indexOf("\n");
      const line = this.childOutput.slice(0, split);
      this.childOutput = this.childOutput.slice(split + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type === "exit") {
        child.exitReason = String(message.reason || "");
      } else if (message.type === "dismissed" && this.currentKey === key) {
        this.dismissedKey = key;
        this._stop();
      } else if (message.type === "error") {
        this._fail(key, String(message.message || "原生黑屏无法显示"));
      }
    }
  }

  /** @param {string} key */
  _start(key) {
    if (!this.binaryPath) {
      this._fail(key, "未找到原生黑屏程序");
      return false;
    }
    let child;
    try { child = this.spawnProcess(this.binaryPath); }
    catch (error) {
      this._fail(key, String(error));
      return false;
    }
    this.child = child;
    child.stdout?.on("data", (/** @type {unknown} */ chunk) => this._receive(chunk, key, child));
    child.stderr?.on("data", () => {});
    child.stdin?.on("error", (/** @type {unknown} */ error) => {
      if (this.child === child) this._fail(key, String(error));
    });
    child.on("error", (/** @type {unknown} */ error) => {
      if (this.child === child) this._fail(key, String(error));
    });
    child.on("exit", (/** @type {unknown} */ code, /** @type {unknown} */ signal) => this._handleExit(key, child, code, signal));
    return true;
  }

  /** @param {string} key @param {any} child @param {unknown} code @param {unknown} signal */
  _handleExit(key, child, code, signal) {
    if (this.child !== child) return;
    const reason = `原生黑屏意外退出（${child.exitReason || (code ?? signal ?? "unknown")}）`;
    console.warn("Pomodoro AIO 原生黑屏退出", { key, reason, restartCount:this.restartCount });
    if (this.destroyed || this.currentKey !== key || this.restartCount >= MAX_NATIVE_RESTARTS) {
      this._fail(key, reason);
      return;
    }
    this.restartCount += 1;
    this.child = null;
    this.childOutput = "";
    if (!this._start(key)) return;
    // A restart can happen long after the last sync.
    const elapsedMs = this.runtime?.status === "running" ? Math.max(0, this.now() - this.syncedAtMs) : 0;
    if (!this._show(elapsedMs)) this._fail(key, reason);
  }

  /** @param {number} [elapsedMs] */
  _show(elapsedMs=0) {
    const runtime = this.runtime;
    const prompt = blackoutPrompt(/** @type {Record<string, any>} */ (runtime), this.settings);
    const syncedLeftMs = runtime && Number.isFinite(runtime.leftMs) ? runtime.leftMs : this.leftSec * 1000;
    return this._send({
      type:"show", label:prompt.label, title:prompt.title,
      leftMs:Math.max(0, Math.ceil(syncedLeftMs - elapsedMs)),
      paused:runtime?.status === "paused"
    });
  }

  /** @param {Record<string, any> | null | undefined} runtime @param {Record<string, any> | null | undefined} settings @param {number} leftSec */
  sync(runtime, settings, leftSec) {
    this.runtime = runtime || null;
    this.settings = settings || null;
    this.leftSec = leftSec;
    this.syncedAtMs = this.now();
    const key = blackoutKey(runtime);
    if (key !== this.currentKey) {
      this._stop();
      this.fallback.sync(null, null, 0);
      this.currentKey = key;
      this.failedKey = "";
      this.finishedKey = "";
      this.finishUntilMs = 0;
      this.restartCount = 0;
      if (this.dismissedKey !== key) this.dismissedKey = "";
    }
    if (!shouldShowBlackout(runtime, settings) || this.dismissedKey === key) {
      this._stop();
      this.fallback.sync(null, null, 0);
      return false;
    }
    if (this.failedKey === key) return this.fallback.sync(runtime, settings, leftSec);
    if (!this.child && !this._start(key)) return this.fallback.sync(runtime, settings, leftSec);
    if (!this._show()) {
      this._fail(key, "无法向原生黑屏发送计时状态");
      return this.fallback.sync(runtime, settings, leftSec);
    }
    if (leftSec <= 0 && this.finishedKey !== key) {
      this.finishedKey = key;
      this.finishUntilMs = this.now() + 320;
    }
    return true;
  }

  isFinishing() { return this.finishUntilMs > this.now() || this.fallback.isFinishing(); }

  destroy() {
    this.destroyed = true;
    this._stop();
    this.fallback.destroy();
  }
}

module.exports = { NativeBlackoutController };
