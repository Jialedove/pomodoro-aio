// 时间归属选择屏：纯黑全屏，直接在黑屏上选择工作 / 休息 / 小计时。
// macOS 由原生程序 pomodoro-accounting 覆盖所有显示器；其他平台或原生程序不可用时，在 Obsidian 窗口内绘制同样的界面。

const HOLD_MS = 3000;
const ENTER_GUARD_MS = 800;

/**
 * @typedef {{id:string,name:string,durationMin:number,workspaceCommandId:string,lightProgramId:string,blackout:boolean}} ModuleItem
 * @typedef {{id:string,title:string}} Option
 * @typedef {object} ScreenData
 * @property {"idle"|"paused"|"awaiting"} reason
 * @property {string} label
 * @property {string} title
 * @property {boolean} closable 提醒模式或手动打开时可直接关闭；否则只能长按 Esc 紧急退出
 * @property {"work"|"rest"|"declare"} initialTab
 * @property {string} display 选择界面所在显示器："main"、"pointer" 或显示器 UUID（窗口内界面忽略）
 * @property {ModuleItem[]} workModules
 * @property {ModuleItem[]} restModules
 * @property {string|null} defaultWorkId
 * @property {string|null} defaultRestId
 * @property {string[]} candidates 当日全部未勾选待办
 * @property {string[]} restPresets
 * @property {Option[]} workspaceCommands
 * @property {Option[]} lightPrograms
 * @property {string} againText 小计时到点后的“再来 5 分钟”，为空时不显示
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

/** @param {unknown} value */
function formatMinutes(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
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
    /** @type {string | null} */
    this.selectedPreset = null;
    /** @type {number | null} */
    this.holdStartedAt = null;
    /** @type {number | null} */
    this.holdFrame = null;
    /** @type {any[]} */
    this.actionButtons = [];
    /** @type {Record<string, any>} */
    this.panels = {};
    this.listId = `pmd-as-candidates-${Math.floor(Math.random() * 1e9)}`;
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

  /** @param {string} text @param {string} cls @param {() => void} onClick */
  _action(text, cls, onClick) {
    const button = this._button(text, cls, onClick);
    this.actionButtons.push(button);
    return button;
  }

  /** @param {string} label @param {any} control */
  _field(label, control) {
    const row = this._el("div", "pmd-as-field");
    row.append(this._el("span", "pmd-as-field-label", label), control);
    return row;
  }

  /** @param {Option[]} options @param {string} selected @param {string} label */
  _select(options, selected, label) {
    const select = this._el("select", "pmd-as-select");
    select.setAttribute("aria-label", label);
    options.forEach(option => {
      const item = this._el("option", "", option.title);
      item.value = option.id;
      select.appendChild(item);
    });
    this._choose(select, selected);
    return select;
  }

  /** 选中某个值；模块引用的选项已不在列表里时保留原值，避免开始时被悄悄改掉。 @param {any} select @param {string} value */
  _choose(select, value) {
    if (value && !Array.from(select.children || []).some((/** @type {any} */ option) => option.value === value)) {
      const item = this._el("option", "", "当前设置（已不可用）");
      item.value = value;
      select.appendChild(item);
    }
    select.value = value;
  }

  /** @param {any} input @param {number[]} chips @param {() => void} [onChange] */
  _minutes(input, chips, onChange = () => {}) {
    const row = this._el("div", "pmd-as-row");
    input.className = "pmd-as-input is-minutes";
    input.type = "number";
    input.min = "1";
    input.setAttribute("aria-label", "时长（分钟）");
    input.oninput = onChange;
    row.append(input, this._el("span", "pmd-as-muted", "分钟"));
    chips.forEach(value => row.appendChild(this._button(String(value), "is-chip", () => { input.value = String(value); onChange(); })));
    return row;
  }

  /** @param {any} more */
  _moreToggle(more) {
    more.hidden = true;
    const toggle = this._button("更多选项 ▸", "pmd-as-link", () => {
      more.hidden = !more.hidden;
      toggle.textContent = more.hidden ? "更多选项 ▸" : "更多选项 ▾";
    });
    return toggle;
  }

  _lightOptions() {
    return [{ id:"", title:"灯光：继承默认" }, { id:"none", title:"灯光：不联动" },
      ...this.data.lightPrograms.map(program => ({ id:program.id, title:`灯光：${program.title}` }))];
  }

  _checkbox() {
    const label = this._el("label", "pmd-as-check");
    const box = this._el("input");
    box.type = "checkbox";
    label.append(box, this._el("span", "", "执行时黑屏"));
    return { label, box };
  }

  /** @param {ModuleItem[]} modules @param {string|null} selected @param {string} noun */
  _modulePicker(modules, selected, noun) {
    if (modules.length < 2) return null;
    return this._select(modules.map((module, index) => ({ id:module.id, title:`第 ${index + 1} 个${noun}：${module.name}` })), selected || modules[0].id, `选择${noun}模块`);
  }

  _render() {
    const data = this.data;
    this.root.replaceChildren();
    const panel = this._el("div", "pmd-as-panel");
    this.root.appendChild(panel);
    if (data.closable) panel.appendChild(this._button("关闭  esc", "pmd-as-close", () => void this.choose({ action:"close" })));
    this.labelEl = this._el("div", "pmd-as-label", data.label);
    panel.append(this.labelEl, this._el("div", "pmd-as-title", data.title));
    if (data.reason === "paused") {
      const row = this._el("div", "pmd-as-row");
      row.append(this._action("继续计时", "is-primary is-large", () => this._submit({ action:"resume" })),
        this._action("完成本段", "is-large", () => this._submit({ action:"complete" })));
      panel.appendChild(row);
    } else if (data.reason === "awaiting") {
      const row = this._el("div", "pmd-as-row");
      row.append(this._action(`开始下一段：${data.currentName}`, "is-primary is-large", () => this._submit({ action:"next" })));
      panel.appendChild(row);
    } else {
      if (data.againText) panel.appendChild(this._action(data.againText, "is-chip", () => this._submit({ action:"again" })));
      const tabs = this._el("div", "pmd-as-row pmd-as-tabs");
      /** @type {Record<string, any>} */
      this.tabButtons = {};
      [["work", "1  工作"], ["rest", "2  休息"], ["declare", "3  小计时"]].forEach(([key, text]) => {
        const button = this._button(text, "pmd-as-tab", () => this._selectTab(key));
        button.setAttribute("role", "tab");
        this.tabButtons[key] = button;
        tabs.appendChild(button);
      });
      panel.appendChild(tabs);
      const body = this._el("div", "pmd-as-body");
      this.panels = { work:this._renderWork(), rest:this._renderRest(), declare:this._renderDeclare() };
      Object.values(this.panels).forEach(item => body.appendChild(item.root));
      panel.appendChild(body);
      this._selectTab(this.panels[this.tab] ? this.tab : "work", false);
    }
    this.status = this._el("div", "pmd-as-status");
    this.status.setAttribute("role", "status");
    panel.appendChild(this.status);
    if (data.snoozesLeft > 0) {
      panel.appendChild(this._action(`${data.snoozeMin} 分钟后再提醒（今天剩 ${data.snoozesLeft} 次）`, "pmd-as-link", () => this._submit({ action:"snooze" })));
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

  /** @param {string} key @param {boolean} [animate] */
  _selectTab(key, animate = true) {
    if (this.busy || !this.panels[key]) return;
    this.tab = key;
    Object.entries(this.tabButtons || {}).forEach(([name, button]) => {
      button.classList.toggle("is-selected", name === key);
      button.setAttribute("aria-selected", String(name === key));
    });
    Object.entries(this.panels).forEach(([name, item]) => {
      item.root.hidden = name !== key;
      item.root.classList.toggle("is-entering", animate && name === key);
    });
    if (this.status) this.status.textContent = "";
    this._focus();
  }

  _renderWork() {
    const root = this._el("div", "pmd-as-tabpanel");
    const { workModules, defaultWorkId } = this.data;
    if (!workModules.length) {
      root.appendChild(this._el("div", "pmd-as-faint", "序列里还没有工作模块，请先在番茄视图中添加。"));
      return { root, focus:null };
    }
    const picker = this._modulePicker(workModules, defaultWorkId, "工作");
    if (picker) root.appendChild(picker);
    const name = this._el("input", "pmd-as-input");
    name.type = "text";
    name.placeholder = "现在要做的事（下拉选择今日待办，或直接输入）";
    name.setAttribute("aria-label", "现在要做的事");
    name.setAttribute("list", this.listId);
    this.datalist = this._el("datalist");
    this.datalist.id = this.listId;
    this._fillCandidates();
    const minutes = this._el("input");
    const layout = this._select([{ id:"", title:"布局：不切换" }, ...this.data.workspaceCommands.map(command => ({ id:command.id, title:`布局：${command.title}` }))], "", "工作区布局");
    const light = this._select(this._lightOptions(), "", "灯光方案");
    const blackout = this._checkbox();
    const more = this._el("div", "pmd-as-row pmd-as-wrap");
    more.append(layout, light, blackout.label);
    const current = () => workModules.find(module => module.id === picker?.value) || workModules.find(module => module.id === defaultWorkId) || workModules[0];
    const fill = () => {
      const module = current();
      name.value = module.name === "工作" ? "" : module.name;
      minutes.value = formatMinutes(module.durationMin);
      this._choose(layout, module.workspaceCommandId);
      this._choose(light, module.lightProgramId);
      blackout.box.checked = module.blackout;
    };
    if (picker) picker.onchange = fill;
    fill();
    const submit = () => {
      const task = name.value.replace(/​/g, "").trim();
      if (!task) { this.showError("先写下现在要做的事", false); name.focus(); return; }
      const duration = Number(minutes.value);
      if (!(duration >= 1 && duration <= 480)) { this.showError("时长须为 1–480 分钟", false); return; }
      this._submit({ action:"work", moduleId:current().id, name:task, durationMin:duration,
        workspaceCommandId:layout.value, lightProgramId:light.value, blackout:blackout.box.checked });
    };
    name.onkeydown = (/** @type {KeyboardEvent} */ event) => this._enter(event, submit);
    minutes.onkeydown = (/** @type {KeyboardEvent} */ event) => this._enter(event, submit);
    root.append(this._field("事情", name), this.datalist, this._field("时长", this._minutes(minutes, [15, 25, 45, 60])),
      this._moreToggle(more), more, this._action("开始工作  ↵", "is-primary", submit));
    return { root, focus:name };
  }

  _fillCandidates() {
    if (!this.datalist) return;
    this.datalist.replaceChildren();
    (this.data.candidates || []).forEach(task => {
      const option = this._el("option");
      option.value = task;
      this.datalist.appendChild(option);
    });
  }

  _renderRest() {
    const root = this._el("div", "pmd-as-tabpanel");
    const { restModules, defaultRestId, restPresets } = this.data;
    if (!restModules.length) {
      root.appendChild(this._el("div", "pmd-as-faint", "序列里还没有休息模块，请先在番茄视图中添加。"));
      return { root, focus:null };
    }
    const picker = this._modulePicker(restModules, defaultRestId, "休息");
    if (picker) root.appendChild(picker);
    /** @type {Record<string, any>} */
    const presetButtons = {};
    const custom = this._el("input", "pmd-as-input is-medium");
    custom.type = "text";
    custom.placeholder = "其他休息事项";
    custom.setAttribute("aria-label", "其他休息事项");
    /** @param {string|null} preset */
    const choosePreset = preset => {
      this.selectedPreset = preset;
      Object.entries(presetButtons).forEach(([name, button]) => button.classList.toggle("is-selected", name === preset));
      if (preset) custom.value = "";
    };
    if (restPresets.length) {
      const grid = this._el("div", "pmd-as-row pmd-as-wrap pmd-as-presets");
      restPresets.forEach(preset => {
        presetButtons[preset] = this._button(preset, "pmd-as-tab is-preset", () => choosePreset(preset));
        grid.appendChild(presetButtons[preset]);
      });
      root.appendChild(grid);
    }
    custom.oninput = () => { if (custom.value) choosePreset(null); };
    const minutes = this._el("input");
    const light = this._select(this._lightOptions(), "", "灯光方案");
    const blackout = this._checkbox();
    const more = this._el("div", "pmd-as-row pmd-as-wrap");
    more.append(light, blackout.label);
    const current = () => restModules.find(module => module.id === picker?.value) || restModules.find(module => module.id === defaultRestId) || restModules[0];
    const fill = () => {
      const module = current();
      if (restPresets.includes(module.name)) choosePreset(module.name);
      else { choosePreset(null); custom.value = module.name === "休息" ? "" : module.name; }
      minutes.value = formatMinutes(module.durationMin);
      this._choose(light, module.lightProgramId);
      blackout.box.checked = module.blackout;
    };
    if (picker) picker.onchange = fill;
    fill();
    const submit = () => {
      const name = this.selectedPreset || custom.value.trim();
      if (!name) { this.showError("先选一个休息事项，或写下其他休息事项", false); return; }
      const duration = Number(minutes.value);
      if (!(duration >= 1 && duration <= 480)) { this.showError("时长须为 1–480 分钟", false); return; }
      this._submit({ action:"rest", moduleId:current().id, name, durationMin:duration, lightProgramId:light.value, blackout:blackout.box.checked });
    };
    custom.onkeydown = (/** @type {KeyboardEvent} */ event) => this._enter(event, submit);
    minutes.onkeydown = (/** @type {KeyboardEvent} */ event) => this._enter(event, submit);
    root.append(this._field("其他", custom), this._field("时长", this._minutes(minutes, [5, 10, 15, 20])),
      this._moreToggle(more), more, this._action("开始休息  ↵", "is-primary", submit));
    return { root, focus:null };
  }

  _renderDeclare() {
    const root = this._el("div", "pmd-as-tabpanel");
    const kinds = this._el("div", "pmd-as-row");
    const leisure = this._button("消遣", "pmd-as-tab is-small", () => { this.declareKind = "leisure"; refresh(); });
    const errand = this._button("事务", "pmd-as-tab is-small", () => { this.declareKind = "errand"; refresh(); });
    kinds.append(leisure, errand);
    const reason = this._el("input", "pmd-as-input");
    reason.type = "text";
    reason.setAttribute("aria-label", "理由");
    const minutes = this._el("input");
    minutes.value = String(Math.max(5, Math.min(30, this.data.leisureLeftMin || 15)));
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
    const minuteRow = this._minutes(minutes, [10, 15, 30, 60], refresh);
    refresh();
    const submit = () => {
      if (!reason.value.trim()) { this.showError("请写下理由", false); reason.focus(); return; }
      const value = Number(minutes.value);
      if (!(value >= 1 && value <= 480)) { this.showError("时长须为 1–480 分钟", false); return; }
      this._submit({ action:"declare", kind:this.declareKind, reason:reason.value.trim(), minutes:value });
    };
    reason.onkeydown = (/** @type {KeyboardEvent} */ event) => this._enter(event, submit);
    minutes.onkeydown = (/** @type {KeyboardEvent} */ event) => this._enter(event, submit);
    root.append(kinds, reason, minuteRow, hint,
      this._el("div", "pmd-as-faint", "小计时不算工作时间，到点后必须重新选择；记录写入当日日记。"),
      this._action("开始小计时  ↵", "is-primary", submit));
    return { root, focus:reason };
  }

  /** @param {KeyboardEvent} event @param {() => void} submit */
  _enter(event, submit) {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (this.now() - this.shownAt >= ENTER_GUARD_MS) submit();
  }

  _focus() {
    const target = this.panels[this.tab]?.focus || this.root;
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
    if (patch.candidates) this._fillCandidates();
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
    const typing = ["INPUT", "SELECT"].includes(/** @type {any} */ (event.target)?.tagName);
    if (!typing && this.data.reason === "idle" && ["1", "2", "3"].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      this._selectTab(["work", "rest", "declare"][Number(event.key) - 1]);
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
