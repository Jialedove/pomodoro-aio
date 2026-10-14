// 强制模式的 L3 全屏遮罩：只有一个“去选择”按钮，点了由插件打开选择弹窗。
// macOS 用原生助手覆盖所有显示器；其他平台或助手不可用时退回 Obsidian 窗口内遮罩（复用黑屏样式）。

/** @param {string} binaryPath */
function defaultSpawn(binaryPath) {
  const { spawn } = require("node:child_process");
  return spawn(binaryPath, [], { shell:false, stdio:["pipe", "pipe", "pipe"] });
}

class AccountingOverlay {
  /**
   * @param {{document:Document|null, binaryPath:string|null, spawnProcess?:(path:string)=>any, onChoose:()=>void, onUnavailable?:(reason:string)=>void}} options
   */
  constructor({ document, binaryPath, spawnProcess = defaultSpawn, onChoose, onUnavailable = () => {} }) {
    this.document = document;
    this.binaryPath = binaryPath;
    this.spawnProcess = spawnProcess;
    this.onChoose = onChoose;
    this.onUnavailable = onUnavailable;
    /** @type {any} */
    this.child = null;
    this.childOutput = "";
    /** @type {HTMLElement | null} */
    this.element = null;
    this.nativeFailed = !binaryPath;
    this.message = { label:"", title:"" };
  }

  get visible() {
    return !!this.child || !!this.element;
  }

  /** @param {{label:string, title:string}} message */
  show(message) {
    this.message = message;
    if (this.element) { this._renderDom(); return; }
    if (this.child) { this._send({ type:"update", mode:"prompt", buttonTitle:"去选择", ...message }); return; }
    if (!this.nativeFailed && this._startNative()) return;
    this._renderDom();
  }

  hide() {
    this._stopNative();
    this.element?.remove();
    this.element = null;
  }

  destroy() {
    this.hide();
  }

  _choose() {
    this.hide();
    this.onChoose();
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

  _startNative() {
    let child;
    try { child = this.spawnProcess(/** @type {string} */ (this.binaryPath)); }
    catch (error) { this._failNative(String(error)); return false; }
    this.child = child;
    this.childOutput = "";
    child.stdout?.on("data", (/** @type {unknown} */ chunk) => this._receive(chunk, child));
    child.stderr?.on("data", () => {});
    child.stdin?.on("error", (/** @type {unknown} */ error) => { if (this.child === child) this._failNative(String(error)); });
    child.on("error", (/** @type {unknown} */ error) => { if (this.child === child) this._failNative(String(error)); });
    child.on("exit", () => {
      // 被外部结束（不是用户点按钮或插件 hide）：当作关掉，按宽限时间重新盖上。
      if (this.child === child) { this.child = null; this.onChoose(); }
    });
    if (!this._send({ type:"show", mode:"prompt", buttonTitle:"去选择", ...this.message })) {
      this._failNative("无法向原生遮罩发送消息");
      return false;
    }
    return true;
  }

  /** @param {unknown} chunk @param {any} child */
  _receive(chunk, child) {
    if (this.child !== child) return;
    this.childOutput += String(chunk);
    while (this.childOutput.includes("\n")) {
      const split = this.childOutput.indexOf("\n");
      const line = this.childOutput.slice(0, split);
      this.childOutput = this.childOutput.slice(split + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type === "dismissed") this._choose();
      else if (message.type === "error") this._failNative(String(message.message || "原生遮罩无法显示"));
    }
  }

  /** @param {string} reason */
  _failNative(reason) {
    this.nativeFailed = true;
    this._stopNative();
    this.onUnavailable(reason);
    this._renderDom();
  }

  _stopNative() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.write('{"type":"hide"}\n'); } catch { /* 进程可能已退出 */ }
    try { child.stdin.end(); } catch { /* 进程可能已退出 */ }
    const timeout = setTimeout(() => { if (child.exitCode == null) child.kill(); }, 1000);
    /** @type {any} */ (timeout).unref?.();
  }

  _renderDom() {
    const document = this.document;
    if (!document?.body) return;
    if (!this.element) {
      const overlay = document.createElement("div");
      overlay.className = "pmd-blackout-overlay pmd-accounting-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "时间归属提醒");
      const content = document.createElement("div");
      content.className = "pmd-blackout-content";
      const label = document.createElement("div");
      label.className = "pmd-blackout-label";
      const title = document.createElement("div");
      title.className = "pmd-blackout-title";
      const button = document.createElement("button");
      button.className = "pmd-blackout-exit";
      button.type = "button";
      button.textContent = "去选择";
      button.onclick = event => { event.stopPropagation(); this._choose(); };
      content.append(label, title, button);
      overlay.appendChild(content);
      document.body.appendChild(overlay);
      this.element = overlay;
    }
    const [label, title] = /** @type {HTMLElement[]} */ (Array.from(this.element.querySelectorAll(".pmd-blackout-label, .pmd-blackout-title")));
    if (label) label.textContent = this.message.label;
    if (title) title.textContent = this.message.title;
  }
}

module.exports = { AccountingOverlay };
