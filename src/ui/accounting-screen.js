// 时间归属选择屏：黑色全屏，直接在黑屏上选择工作 / 休息 / 不计时。
// macOS 由原生程序 pomodoro-accounting 覆盖所有显示器；其他平台或原生程序不可用时，在 Obsidian 窗口内绘制同样的界面。

const HOLD_MS = 3000;
const ENTER_GUARD_MS = 800;

/**
 * @typedef {{id:string,name:string}} ModuleItem
 * @typedef {object} ScreenData
 * @property {"idle"|"paused"|"awaiting"} reason
 * @property {string} label
 * @property {string} title
 * @property {boolean} closable 提醒模式或手动打开时可直接关闭；否则只能长按 Esc 紧急退出
 * @property {"work"|"rest"|"declare"} initialTab
 * @property {ModuleItem[]} workModules
 * @property {string|null} defaultWorkId
 * @property {string} taskName
 * @property {string[]} candidates
 * @property {ModuleItem[]} restModules
 * @property {number} leisureLeftMin
 * @property {boolean} strictBudget
 * @property {number} snoozesLeft
 * @property {number} snoozeMin
 * @property {string} currentName
 */
/** @typedef {{action:string, [key:string]:any}} Choice */
/** @typedef {{ok:boolean, error?:string}} ChoiceResult */

/** @param {string} binaryPath */
function defaultSpawn(binaryPath) {
  const { spawn } = require("node:child_process");
  return spawn(binaryPath, [], { shell:false, stdio:["pipe", "pipe", "pipe"] });
}

/** @param {string} name */
function editableTaskName(name) {
  return name === "工作" ? "" : name;
}

class AccountingScreen {
  /**
   * @param {{document:Document|null, binaryPath:string|null, spawnProcess?:(path:string)=>any,
   *   onChoice:(choice:Choice)=>Promise<ChoiceResult>, onClosed:(reason:string)=>void,
   *   onUnavailable?:(reason:string)=>void, activateObsidian?:()=>Promise<unknown>, now?:()=>number}} options
   */
  constructor({ document, binaryPath, spawnProcess = defaultSpawn, onChoice, onClosed, onUnavailable = () => {}, activateObsidian = async () => {}, now = () => Date.now() }) {
    this.document = document;
    this.binaryPath = binaryPath;
    this.spawnProcess = spawnProcess;
    this.onChoice = onChoice;
    this.onClosed = onClosed;
    this.onUnavailable = onUnavailable;
    this.activateObsidian = activateObsidian;
    this.now = now;
    this.nativeFailed = !binaryPath;
    /** @type {any} */
    this.child = null;
    this.childOutput = "";
    /** @type {ScreenData | null} */
    this.data = null;
    /** @type {DomScreen | null} */
    this.dom = null;
  }

  get visible() {
    return !!this.child || !!this.dom;
  }

  /** @param {ScreenData} data */
  show(data) {
    if (this.visible) { this.update(data); return; }
    this.data = data;
    if (!this.nativeFailed && this._startNative()) return;
    this._showDom();
  }

  /** @param {Partial<ScreenData>} patch */
  update(patch) {
    if (!this.data) return;
    this.data = { ...this.data, ...patch };
    if (this.child) this._send({ type:"update", ...patch });
    else this.dom?.update(patch);
  }

  hide() {
    this._stopNative();
    this.dom?.destroy();
    this.dom = null;
  }

  destroy() {
    this.hide();
  }

  /** @param {Choice} choice */
  async _handleChoice(choice) {
    // 关闭和紧急退出由界面自己结束，这里只负责记录。
    if (choice.action === "close" || choice.action === "emergency") {
      this.hide();
      this.onClosed(choice.action);
      return;
    }
    let result;
    try { result = await this.onChoice(choice); }
    catch (error) { result = { ok:false, error:String(error instanceof Error ? error.message : error) }; }
    if (!this.visible) return;
    if (result?.ok) {
      this.hide();
      this.onClosed("chosen");
    } else {
      const message = result?.error || "操作失败，请重试";
      if (this.child) this._send({ type:"error", message });
      else this.dom?.showError(message);
    }
  }

  // ---- 原生 ----

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
      // 不是插件 hide、也不是用户关闭：程序被外部结束，按关闭处理，阶梯按间隔再次出现。
      if (this.child !== child) return;
      this.child = null;
      this.onClosed("exited");
    });
    if (!this._send({ type:"show", .../** @type {ScreenData} */ (this.data) })) {
      this._failNative("无法向原生选择屏发送消息");
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
      if (message.type === "choice") void this._handleChoice(message);
    }
  }

  /** @param {string} reason */
  _failNative(reason) {
    this.nativeFailed = true;
    this._stopNative();
    this.onUnavailable(reason);
    this._showDom();
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

  // ---- Obsidian 窗口内 ----

  _showDom() {
    // 原生程序启动失败时 _failNative 已经切到窗口内界面，避免重复创建。
    if (this.dom || !this.document?.body || !this.data) return;
    void this.activateObsidian();
    this.dom = new DomScreen(this.document, this.data, choice => this._handleChoice(choice), this.now);
  }
}

/** Obsidian 窗口内的黑色选择屏，与原生界面结构一致。 */
class DomScreen {
  /** @param {Document} document @param {ScreenData} data @param {(choice:Choice)=>Promise<void>} choose @param {()=>number} now */
  constructor(document, data, choose, now) {
    this.document = document;
    this.data = data;
    this.choose = choose;
    this.now = now;
    this.shownAt = now();
    this.busy = false;
    /** @type {string} */
    this.tab = data.initialTab || "work";
    this.declareKind = "leisure";
    /** @type {number | null} */
    this.holdStartedAt = null;
    /** @type {number | null} */
    this.holdFrame = null;
    this.root = this._el("div", "pmd-accounting-screen");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "时间归属选择");
    this.root.tabIndex = -1;
    this._onKeyDown = (/** @type {KeyboardEvent} */ event) => this._keyDown(event);
    this._onKeyUp = (/** @type {KeyboardEvent} */ event) => this._keyUp(event);
    document.addEventListener("keydown", this._onKeyDown, true);
    document.addEventListener("keyup", this._onKeyUp, true);
    this._render();
    document.body.appendChild(this.root);
    this._focus();
  }

  /** @param {string} tag @param {string} [cls] @param {string} [text] @returns {any} */
  _el(tag, cls = "", text = "") {
    const el = this.document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  }

  /** @param {string} text @param {string} cls @param {() => void} onClick */
  _button(text, cls, onClick) {
    const button = this._el("button", `pmd-as-btn ${cls}`, text);
    button.type = "button";
    button.onclick = (/** @type {Event} */ event) => { event.stopPropagation(); onClick(); };
    return button;
  }

  _render() {
    const data = this.data;
    this.root.replaceChildren();
    const panel = this._el("div", "pmd-as-panel");
    this.root.appendChild(panel);
    if (data.closable) panel.appendChild(this._button("关闭  esc", "pmd-as-close", () => void this.choose({ action:"close" })));
    this.labelEl = this._el("div", "pmd-as-label", data.label);
    panel.appendChild(this.labelEl);
    panel.appendChild(this._el("div", "pmd-as-title", data.title));
    /** @type {HTMLButtonElement[]} */
    this.actionButtons = [];
    if (data.reason === "paused") {
      const row = this._el("div", "pmd-as-row");
      row.append(this._action("继续计时", "is-primary is-large", { action:"resume" }), this._action("完成本段", "is-large", { action:"complete" }));
      panel.appendChild(row);
    } else if (data.reason === "awaiting") {
      const row = this._el("div", "pmd-as-row");
      row.append(this._action(`开始下一段：${data.currentName}`, "is-primary is-large", { action:"next" }));
      panel.appendChild(row);
    } else {
      const tabs = this._el("div", "pmd-as-row pmd-as-tabs");
      /** @type {Record<string, any>} */
      this.tabButtons = {};
      [["work", "1  工作"], ["rest", "2  休息"], ["declare", "3  不计时"]].forEach(([key, text]) => {
        const button = this._button(text, "pmd-as-tab", () => this._select(key));
        button.setAttribute("role", "tab");
        this.tabButtons[key] = button;
        tabs.appendChild(button);
      });
      panel.appendChild(tabs);
      this.body = this._el("div", "pmd-as-body");
      panel.appendChild(this.body);
      this._select(this.tab, false);
    }
    this.status = this._el("div", "pmd-as-status");
    this.status.setAttribute("role", "status");
    panel.appendChild(this.status);
    if (data.snoozesLeft > 0) {
      const snooze = this._button(`${data.snoozeMin} 分钟后再提醒（今天剩 ${data.snoozesLeft} 次）`, "pmd-as-link", () => this._submit({ action:"snooze" }));
      this.actionButtons.push(snooze);
      panel.appendChild(snooze);
    } else {
      panel.appendChild(this._el("div", "pmd-as-faint", "今天的稍后提醒已用完"));
    }
    if (!data.closable) {
      const hold = this._el("div", "pmd-as-hold");
      this.holdHint = this._el("div", "pmd-as-faint", "长按 esc 3 秒紧急退出");
      const bar = this._el("div", "pmd-as-holdbar");
      this.holdFill = this._el("div", "pmd-as-holdfill");
      bar.appendChild(this.holdFill);
      hold.append(this.holdHint, bar);
      panel.appendChild(hold);
    }
  }

  /** @param {string} text @param {string} cls @param {Choice} choice */
  _action(text, cls, choice) {
    const button = this._button(text, cls, () => this._submit(choice));
    this.actionButtons.push(button);
    return button;
  }

  /** @param {string} key @param {boolean} [animate] */
  _select(key, animate = true) {
    if (this.busy) return;
    this.tab = key;
    Object.entries(this.tabButtons || {}).forEach(([name, button]) => {
      button.classList.toggle("is-selected", name === key);
      button.setAttribute("aria-selected", String(name === key));
    });
    this.body.replaceChildren();
    this.body.classList.toggle("is-entering", animate);
    if (key === "work") this._renderWork();
    else if (key === "rest") this._renderRest();
    else this._renderDeclare();
    if (this.status) this.status.textContent = "";
    this._focus();
  }

  _renderWork() {
    const { workModules, defaultWorkId, taskName } = this.data;
    if (!workModules.length) { this.body.appendChild(this._el("div", "pmd-as-faint", "序列里还没有工作模块，请先在番茄视图中添加。")); return; }
    /** @type {any} */
    let select = null;
    if (workModules.length > 1) {
      select = this._el("select", "pmd-as-select");
      select.setAttribute("aria-label", "从哪个工作模块开始");
      workModules.forEach((module, index) => {
        const option = this._el("option", "", `第 ${index + 1} 个工作：${module.name}`);
        option.value = module.id;
        select.appendChild(option);
      });
      if (defaultWorkId) select.value = defaultWorkId;
      this.body.appendChild(select);
    }
    const input = this._el("input", "pmd-as-input");
    input.type = "text";
    input.placeholder = "现在要做的事";
    input.setAttribute("aria-label", "现在要做的事");
    input.value = taskName;
    if (select) select.onchange = () => { input.value = editableTaskName(workModules.find(module => module.id === select.value)?.name || ""); };
    this.body.appendChild(input);
    this.candidatesEl = this._el("div", "pmd-as-chips");
    this.body.appendChild(this.candidatesEl);
    this._renderCandidates(input);
    const submit = () => {
      const name = input.value.replace(/​/g, "").trim();
      if (!name) { this.showError("先写下现在要做的事", false); input.focus(); return; }
      this._submit({ action:"work", moduleId:select?.value || defaultWorkId || workModules[0].id, name });
    };
    input.onkeydown = (/** @type {KeyboardEvent} */ event) => this._enter(event, submit);
    this.body.appendChild(this._primary("开始工作  ↵", submit));
    this.focusTarget = input;
  }

  /** @param {any} [input] */
  _renderCandidates(input = this.body?.querySelector?.(".pmd-as-input")) {
    if (!this.candidatesEl) return;
    this.candidatesEl.replaceChildren();
    const names = (this.data.candidates || []).slice(0, 6);
    if (!names.length) return;
    this.candidatesEl.appendChild(this._el("div", "pmd-as-faint", "今日待办"));
    const row = this._el("div", "pmd-as-row pmd-as-wrap");
    names.forEach(name => row.appendChild(this._button(name, "is-chip", () => { if (input) { input.value = name; input.focus(); } })));
    this.candidatesEl.appendChild(row);
  }

  _renderRest() {
    const { restModules } = this.data;
    if (!restModules.length) { this.body.appendChild(this._el("div", "pmd-as-faint", "序列里还没有休息模块，请先在番茄视图中添加。")); return; }
    this.body.appendChild(this._el("div", "pmd-as-faint", "点一下就开始"));
    const row = this._el("div", "pmd-as-row pmd-as-wrap");
    restModules.forEach(module => row.appendChild(this._action(module.name, "is-large", { action:"rest", moduleId:module.id })));
    this.body.appendChild(row);
    this.focusTarget = null;
  }

  _renderDeclare() {
    const kinds = this._el("div", "pmd-as-row");
    const leisure = this._button("消遣", "pmd-as-tab is-small", () => { this.declareKind = "leisure"; refresh(); });
    const errand = this._button("事务", "pmd-as-tab is-small", () => { this.declareKind = "errand"; refresh(); });
    kinds.append(leisure, errand);
    const reason = this._el("input", "pmd-as-input");
    reason.type = "text";
    reason.setAttribute("aria-label", "理由");
    const minutesRow = this._el("div", "pmd-as-row");
    const minutes = this._el("input", "pmd-as-input is-minutes");
    minutes.type = "number";
    minutes.min = "1";
    minutes.setAttribute("aria-label", "时长（分钟）");
    minutes.value = String(Math.max(5, Math.min(30, this.data.leisureLeftMin || 15)));
    minutesRow.append(minutes, this._el("span", "pmd-as-muted", "分钟"));
    [10, 15, 30, 60].forEach(value => minutesRow.appendChild(this._button(String(value), "is-chip", () => { minutes.value = String(value); refresh(); })));
    const hint = this._el("div", "pmd-as-muted");
    const refresh = () => {
      leisure.classList.toggle("is-selected", this.declareKind === "leisure");
      errand.classList.toggle("is-selected", this.declareKind === "errand");
      reason.placeholder = this.declareKind === "leisure" ? "理由，例如：刷 X、看视频" : "理由，例如：开会、处理快递";
      const left = this.data.leisureLeftMin;
      const planned = Number(minutes.value) || 0;
      const over = this.declareKind === "leisure" && planned > left;
      hint.classList.toggle("is-warning", over);
      hint.textContent = this.declareKind === "errand" ? "事务不占消遣额度，同样记入日记。"
        : this.data.strictBudget && left < 1 ? "今日消遣额度已用完（强制模式）。"
          : over ? (this.data.strictBudget ? `今日消遣剩余 ${left} 分钟，强制模式下会截为 ${left} 分钟。`
            : `今日消遣剩余 ${left} 分钟，本次会超出 ${Math.round(planned - left)} 分钟并记入日记。`)
            : `今日消遣剩余 ${left} 分钟。`;
    };
    minutes.oninput = refresh;
    refresh();
    const submit = () => {
      if (!reason.value.trim()) { this.showError("请写下理由", false); reason.focus(); return; }
      this._submit({ action:"declare", kind:this.declareKind, reason:reason.value.trim(), minutes:Number(minutes.value) });
    };
    reason.onkeydown = (/** @type {KeyboardEvent} */ event) => this._enter(event, submit);
    minutes.onkeydown = (/** @type {KeyboardEvent} */ event) => this._enter(event, submit);
    this.body.append(kinds, reason, minutesRow, hint, this._primary("开始不计时  ↵", submit));
    this.focusTarget = reason;
  }

  /** @param {string} text @param {() => void} submit */
  _primary(text, submit) {
    const button = this._button(text, "is-primary", submit);
    this.actionButtons.push(button);
    return button;
  }

  /** @param {KeyboardEvent} event @param {() => void} submit */
  _enter(event, submit) {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (this.now() - this.shownAt >= ENTER_GUARD_MS) submit();
  }

  _focus() {
    const target = this.focusTarget || this.root;
    setTimeout(() => target?.focus?.(), 0);
  }

  /** @param {Choice} choice */
  _submit(choice) {
    if (this.busy) return;
    this.busy = true;
    this.actionButtons.forEach(button => { button.disabled = true; });
    this.status.className = "pmd-as-status";
    this.status.textContent = "正在处理…";
    void this.choose(choice);
  }

  /** @param {string} message @param {boolean} [fromResult] */
  showError(message, fromResult = true) {
    if (fromResult) {
      this.busy = false;
      this.actionButtons.forEach(button => { button.disabled = false; });
    }
    this.status.className = "pmd-as-status is-warning";
    this.status.textContent = message;
  }

  /** @param {Partial<ScreenData>} patch */
  update(patch) {
    this.data = { ...this.data, ...patch };
    if (patch.label !== undefined && this.labelEl) this.labelEl.textContent = this.data.label;
    if (patch.candidates && this.tab === "work") this._renderCandidates();
  }

  /** @param {KeyboardEvent} event */
  _keyDown(event) {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (this.data.closable) void this.choose({ action:"close" });
      else this._startHold();
      return;
    }
    const typing = /** @type {any} */ (event.target)?.tagName === "INPUT" || /** @type {any} */ (event.target)?.tagName === "SELECT";
    if (!typing && this.data.reason === "idle" && ["1", "2", "3"].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      this._select(["work", "rest", "declare"][Number(event.key) - 1]);
    }
  }

  /** @param {KeyboardEvent} event */
  _keyUp(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this._cancelHold();
  }

  _startHold() {
    if (this.holdStartedAt !== null || !this.holdFill) return;
    this.holdStartedAt = this.now();
    this.holdFill.style.transition = "none";
    this.holdHint?.classList.add("is-active");
    const step = () => {
      if (this.holdStartedAt === null) return;
      const progress = Math.min(1, (this.now() - this.holdStartedAt) / HOLD_MS);
      this.holdFill.style.width = `${progress * 100}%`;
      if (progress >= 1) {
        this.holdStartedAt = null;
        void this.choose({ action:"emergency" });
        return;
      }
      this.holdFrame = requestAnimationFrame(step);
    };
    this.holdFrame = requestAnimationFrame(step);
  }

  _cancelHold() {
    if (this.holdStartedAt === null) return;
    this.holdStartedAt = null;
    if (this.holdFrame !== null) cancelAnimationFrame(this.holdFrame);
    this.holdHint?.classList.remove("is-active");
    if (this.holdFill) {
      this.holdFill.style.transition = "width 0.2s ease-out";
      this.holdFill.style.width = "0%";
    }
  }

  destroy() {
    this._cancelHold();
    this.document.removeEventListener("keydown", this._onKeyDown, true);
    this.document.removeEventListener("keyup", this._onKeyUp, true);
    this.root.remove();
  }
}

module.exports = { AccountingScreen, HOLD_MS };
