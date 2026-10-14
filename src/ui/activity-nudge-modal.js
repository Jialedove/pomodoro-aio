const { Modal } = require("obsidian");

/**
 * @typedef {object} ActivityNudgeOptions
 * @property {"idle"|"paused"} reason
 * @property {number} activeMin
 * @property {number} snoozeMin
 * @property {string} pausedName
 * @property {Array<{id:string,name:string}>} workModules
 * @property {string | null} defaultModuleId
 * @property {() => Promise<string[]>} loadCandidates
 * @property {(moduleId:string, name:string) => Promise<boolean>} onStart
 * @property {() => Promise<unknown>} onResume
 * @property {() => void} onSnooze
 * @property {() => void} onClosed
 */

/** @param {string} name */
function editableTaskName(name) {
  return name === "工作" ? "" : name;
}

class ActivityNudgeModal extends Modal {
  /** @param {any} app @param {ActivityNudgeOptions} options */
  constructor(app, options) {
    super(app);
    this.options = options;
  }

  onOpen() {
    const { reason, activeMin, snoozeMin, pausedName, workModules, defaultModuleId } = this.options;
    const content = this.contentEl;
    content.empty();
    content.addClass("pmd-nudge-modal");
    content.createEl("h2", { text:reason === "paused" ? "计时已暂停" : "现在在做什么？" });
    const used = activeMin >= 1 ? `你已经连续使用电脑约 ${Math.round(activeMin)} 分钟` : "检测到你正在使用电脑";
    content.createEl("p", { cls:"pmd-nudge-lead", text:reason === "paused"
      ? `${used}，但「${pausedName}」还停在暂停状态。`
      : `${used}，但番茄钟没有在计时。写下现在要做的事，然后开始一段工作。` });
    const status = content.createDiv({ cls:"pmd-nudge-status", attr:{ role:"status", "aria-live":"polite" } });
    const actions = content.createDiv({ cls:"pmd-nudge-actions" });
    const buttons = /** @type {HTMLButtonElement[]} */ ([]);
    /** @param {() => Promise<unknown>} action */
    const run = async action => {
      buttons.forEach(button => { button.disabled = true; });
      try {
        if (await action() !== false) this.close();
      } catch (error) {
        console.error("Pomodoro AIO 活动提醒操作失败", error);
        status.setText("操作失败，请稍后重试");
      } finally {
        buttons.forEach(button => { button.disabled = false; });
      }
    };

    if (reason === "paused") {
      buttons.push(actions.createEl("button", { text:"继续计时", cls:"mod-cta", attr:{ type:"button" } }));
      buttons[0].onclick = () => run(this.options.onResume);
    } else if (!workModules.length) {
      content.createEl("p", { text:"序列里还没有工作模块，请先在番茄视图中添加。" });
    } else {
      const fields = content.createDiv({ cls:"pmd-nudge-fields" });
      /** @type {HTMLSelectElement | null} */
      let select = null;
      if (workModules.length > 1) {
        const picker = fields.createEl("select", { cls:"dropdown", attr:{ "aria-label":"从哪个工作模块开始" } });
        workModules.forEach((module, index) => picker.createEl("option", {
          text:`第 ${index + 1} 个工作：${module.name}`, attr:{ value:module.id }
        }));
        if (defaultModuleId) picker.value = defaultModuleId;
        select = picker;
      }
      const moduleId = () => select?.value || defaultModuleId || workModules[0].id;
      const currentName = () => editableTaskName(workModules.find(module => module.id === moduleId())?.name || "");
      const input = fields.createEl("input", { cls:"pmd-input", attr:{
        type:"text", list:"pmd-nudge-candidates", placeholder:"输入/选择事情（未勾选待办）", "aria-label":"现在要做的事情"
      } });
      input.value = currentName();
      if (select) select.onchange = () => { input.value = currentName(); };
      const list = fields.createEl("datalist", { attr:{ id:"pmd-nudge-candidates" } });
      this.options.loadCandidates().then(items => items.forEach(item => list.createEl("option", { attr:{ value:item } })))
        .catch(error => console.warn("Pomodoro AIO 读取日记待办失败", error));
      const start = actions.createEl("button", { text:"开始工作", cls:"mod-cta", attr:{ type:"button" } });
      buttons.push(start);
      const submit = () => {
        const name = input.value.replace(/​/g, "").trim();
        if (!name) { status.setText("先写下现在要做的事"); input.focus(); return; }
        run(() => this.options.onStart(moduleId(), name));
      };
      start.onclick = submit;
      input.onkeydown = event => {
        if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); submit(); }
      };
      window.setTimeout(() => input.focus(), 0);
    }

    const snooze = actions.createEl("button", { text:`${snoozeMin} 分钟后再提醒`, attr:{ type:"button" } });
    buttons.push(snooze);
    snooze.onclick = () => { this.options.onSnooze(); this.close(); };
  }

  onClose() {
    this.contentEl.empty();
    this.options.onClosed();
  }
}

module.exports = { ActivityNudgeModal };
