const { Modal } = require("obsidian");

/**
 * @typedef {object} AccountingModalOptions
 * @property {"idle"|"paused"|"awaiting"} reason
 * @property {"work"|"rest"|"declare"} [initialTab]
 * @property {number | null} stretchMin
 * @property {string} currentName 暂停或等待确认中的模块名称
 * @property {Array<{id:string,name:string}>} workModules
 * @property {Array<{id:string,name:string}>} restModules
 * @property {string | null} defaultWorkId
 * @property {number} leisureLeftMin
 * @property {number} snoozesLeft
 * @property {number} snoozeMin
 * @property {() => Promise<string[]>} loadCandidates
 * @property {(moduleId:string, name:string) => Promise<unknown>} onStartWork
 * @property {(moduleId:string) => Promise<unknown>} onStartRest
 * @property {(input:{kind:"leisure"|"errand", reason:string, minutes:number}) => unknown} onDeclare
 * @property {() => Promise<unknown>} onResume
 * @property {() => Promise<unknown>} onCompleteSegment
 * @property {() => Promise<unknown>} onStartNext
 * @property {() => unknown} onSnooze
 * @property {() => void} onClosed
 */

// 弹窗刚出现时忽略回车，避免把正在输入的内容当作选择提交。
const ENTER_GUARD_MS = 800;

/** @param {string} name */
function editableTaskName(name) {
  return name === "工作" ? "" : name;
}

class AccountingModal extends Modal {
  /** @param {any} app @param {AccountingModalOptions} options */
  constructor(app, options) {
    super(app);
    this.options = options;
    this.openedAtMs = 0;
    /** @type {HTMLButtonElement[]} */
    this.buttons = [];
  }

  onOpen() {
    this.openedAtMs = Date.now();
    const { reason, stretchMin } = this.options;
    const content = this.contentEl;
    content.empty();
    content.addClass("pmd-accounting-modal");
    content.createEl("h2", { text:reason === "paused" ? "计时已暂停" : reason === "awaiting" ? "下一段还没开始" : "现在在做什么？" });
    const used = stretchMin && stretchMin >= 1 ? `已经有 ${stretchMin} 分钟没有归属` : "这段时间还没有归属";
    content.createEl("p", { cls:"pmd-accounting-lead", text:reason === "paused"
      ? `「${this.options.currentName}」已暂停，${used}。`
      : reason === "awaiting" ? `「${this.options.currentName}」等待开始，${used}。`
        : `${used}。选择工作、休息，或写明理由声明不计时。` });
    this.status = content.createDiv({ cls:"pmd-accounting-status", attr:{ role:"status", "aria-live":"polite" } });
    const body = content.createDiv({ cls:"pmd-accounting-body" });
    if (reason === "paused") this._renderActions(body, [
      ["继续计时", () => this._run(this.options.onResume), true],
      ["完成本段", () => this._run(this.options.onCompleteSegment), false]
    ]);
    else if (reason === "awaiting") this._renderActions(body, [[`开始下一段：${this.options.currentName}`, () => this._run(this.options.onStartNext), true]]);
    else this._renderTabs(body);

    const footer = content.createDiv({ cls:"pmd-accounting-footer" });
    if (this.options.snoozesLeft > 0) {
      const snooze = footer.createEl("button", { text:`${this.options.snoozeMin} 分钟后再提醒（今天剩 ${this.options.snoozesLeft} 次）`, attr:{ type:"button" } });
      this.buttons.push(snooze);
      snooze.onclick = () => { if (this.options.onSnooze() !== false) this.close(); };
    } else {
      footer.createSpan({ cls:"pmd-accounting-hint", text:"今天的稍后提醒已用完" });
    }
  }

  /** @param {any} parent @param {Array<[string, () => unknown, boolean]>} actions */
  _renderActions(parent, actions) {
    const row = parent.createDiv({ cls:"pmd-accounting-actions" });
    for (const [text, action, primary] of actions) {
      const button = row.createEl("button", { text, cls:primary ? "mod-cta" : "", attr:{ type:"button" } });
      this.buttons.push(button);
      button.onclick = () => { void action(); };
    }
  }

  /** @param {() => unknown} action */
  async _run(action) {
    this.buttons.forEach(button => { button.disabled = true; });
    try {
      if (await action() !== false) this.close();
    } catch (error) {
      console.error("Pomodoro AIO 时间归属操作失败", error);
      this._setStatus("操作失败，请稍后重试");
    } finally {
      this.buttons.forEach(button => { button.disabled = false; });
    }
  }

  /** @param {string} text */
  _setStatus(text) {
    this.status?.setText(text);
  }

  /** @param {KeyboardEvent} event @param {() => void} submit */
  _onEnter(event, submit) {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (Date.now() - this.openedAtMs >= ENTER_GUARD_MS) submit();
  }

  /** @param {any} parent */
  _renderTabs(parent) {
    const tabs = parent.createDiv({ cls:"pmd-accounting-tabs", attr:{ role:"tablist" } });
    const panels = parent.createDiv({ cls:"pmd-accounting-panels" });
    /** @type {Record<string, {tab:any, panel:any, focus:() => void}>} */
    const entries = {};
    /** @param {"work"|"rest"|"declare"} key */
    const select = key => {
      for (const [name, entry] of Object.entries(entries)) {
        const active = name === key;
        entry.tab.classList.toggle("is-active", active);
        entry.tab.setAttribute("aria-selected", String(active));
        entry.panel.classList.toggle("pmd-hidden", !active);
      }
      this._setStatus("");
      entries[key].focus();
    };
    /** @param {"work"|"rest"|"declare"} key @param {string} label @param {(panel:any) => () => void} render */
    const add = (key, label, render) => {
      const tab = tabs.createEl("button", { text:label, cls:"pmd-accounting-tab", attr:{ type:"button", role:"tab" } });
      const panel = panels.createDiv({ cls:"pmd-accounting-panel", attr:{ role:"tabpanel" } });
      entries[key] = { tab, panel, focus:render(panel) };
      tab.onclick = () => select(key);
    };
    add("work", "工作", panel => this._renderWork(panel));
    add("rest", "休息", panel => this._renderRest(panel));
    add("declare", "不计时", panel => this._renderDeclare(panel));
    window.setTimeout(() => select(this.options.initialTab || "work"), 0);
  }

  /** @param {any} panel @returns {() => void} */
  _renderWork(panel) {
    const { workModules, defaultWorkId } = this.options;
    if (!workModules.length) {
      panel.createEl("p", { text:"序列里还没有工作模块，请先在番茄视图中添加。" });
      return () => {};
    }
    /** @type {HTMLSelectElement | null} */
    let select = null;
    if (workModules.length > 1) {
      const picker = panel.createEl("select", { cls:"dropdown", attr:{ "aria-label":"从哪个工作模块开始" } });
      workModules.forEach((module, index) => picker.createEl("option", { text:`第 ${index + 1} 个工作：${module.name}`, attr:{ value:module.id } }));
      if (defaultWorkId) picker.value = defaultWorkId;
      select = picker;
    }
    const moduleId = () => select?.value || defaultWorkId || workModules[0].id;
    const currentName = () => editableTaskName(workModules.find(module => module.id === moduleId())?.name || "");
    const input = panel.createEl("input", { cls:"pmd-input", attr:{
      type:"text", list:"pmd-accounting-candidates", placeholder:"现在要做的事（可选当日未勾选待办）", "aria-label":"现在要做的事情"
    } });
    input.value = currentName();
    if (select) select.onchange = () => { input.value = currentName(); };
    const list = panel.createEl("datalist", { attr:{ id:"pmd-accounting-candidates" } });
    this.options.loadCandidates().then(items => items.forEach(item => list.createEl("option", { attr:{ value:item } })))
      .catch(error => console.warn("Pomodoro AIO 读取日记待办失败", error));
    const submit = () => {
      const name = input.value.replace(/​/g, "").trim();
      if (!name) { this._setStatus("先写下现在要做的事"); input.focus(); return; }
      void this._run(() => this.options.onStartWork(moduleId(), name));
    };
    this._renderActions(panel, [["开始工作", submit, true]]);
    input.onkeydown = (/** @type {KeyboardEvent} */ event) => this._onEnter(event, submit);
    return () => input.focus();
  }

  /** @param {any} panel @returns {() => void} */
  _renderRest(panel) {
    const { restModules } = this.options;
    if (!restModules.length) {
      panel.createEl("p", { text:"序列里还没有休息模块，请先在番茄视图中添加。" });
      return () => {};
    }
    const picker = panel.createEl("select", { cls:"dropdown", attr:{ "aria-label":"开始哪个休息模块" } });
    restModules.forEach(module => picker.createEl("option", { text:module.name, attr:{ value:module.id } }));
    this._renderActions(panel, [["开始休息", () => this._run(() => this.options.onStartRest(picker.value)), true]]);
    return () => picker.focus();
  }

  /** @param {any} panel @returns {() => void} */
  _renderDeclare(panel) {
    /** @type {"leisure"|"errand"} */
    let kind = "leisure";
    const kinds = panel.createDiv({ cls:"pmd-accounting-kinds" });
    const leisure = kinds.createEl("button", { text:"消遣", cls:"pmd-accounting-kind", attr:{ type:"button" } });
    const errand = kinds.createEl("button", { text:"事务", cls:"pmd-accounting-kind", attr:{ type:"button" } });
    const hint = panel.createEl("p", { cls:"pmd-accounting-hint" });
    const reason = panel.createEl("input", { cls:"pmd-input", attr:{ type:"text", "aria-label":"理由" } });
    const minutesRow = panel.createDiv({ cls:"pmd-accounting-minutes" });
    const minutes = minutesRow.createEl("input", { cls:"pmd-input", attr:{ type:"number", min:"1", step:"1", "aria-label":"时长（分钟）" } });
    minutesRow.createSpan({ text:"分钟" });
    for (const value of [10, 15, 30, 60]) {
      const chip = minutesRow.createEl("button", { text:String(value), cls:"pmd-accounting-chip", attr:{ type:"button" } });
      chip.onclick = () => { minutes.value = String(value); refresh(); };
    }
    const refresh = () => {
      leisure.classList.toggle("is-active", kind === "leisure");
      errand.classList.toggle("is-active", kind === "errand");
      reason.setAttribute("placeholder", kind === "leisure" ? "理由，例如：刷 X、看视频" : "理由，例如：开会、处理快递");
      const left = this.options.leisureLeftMin;
      const planned = Number(minutes.value) || 0;
      hint.setText(kind === "errand" ? "事务不占消遣额度，同样记入日记。"
        : planned > left ? `今日消遣剩余 ${left} 分钟，本次会超出 ${Math.round(planned - left)} 分钟并记入日记。`
          : `今日消遣剩余 ${left} 分钟。`);
      hint.classList.toggle("is-warning", kind === "leisure" && planned > left);
    };
    leisure.onclick = () => { kind = "leisure"; refresh(); };
    errand.onclick = () => { kind = "errand"; refresh(); };
    minutes.oninput = refresh;
    minutes.value = String(Math.max(5, Math.min(30, this.options.leisureLeftMin || 15)));
    refresh();
    const submit = () => void this._run(async () => this.options.onDeclare({ kind, reason:reason.value, minutes:Number(minutes.value) }));
    this._renderActions(panel, [["开始不计时", submit, true]]);
    reason.onkeydown = (/** @type {KeyboardEvent} */ event) => this._onEnter(event, submit);
    minutes.onkeydown = (/** @type {KeyboardEvent} */ event) => this._onEnter(event, submit);
    return () => reason.focus();
  }

  onClose() {
    this.contentEl.empty();
    this.options.onClosed();
  }
}

module.exports = { AccountingModal };
