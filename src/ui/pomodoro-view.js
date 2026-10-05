const { ItemView, setIcon } = require("obsidian");
const { TIMER_STATUS } = require("../core/timer");
const { formatTomatoNumber } = require("../core/validation");
const { workspaceLayoutLabel } = require("../integrations/workspaces-plus");
const { normalizeModuleDefinition } = require("../core/modules");
const { createModuleDraft } = require("../core/module-draft");
/** @typedef {{id:string, type:"work"|"rest", name:string, durationMin:number, blackout:boolean, workspaceCommandId?:string}} ModuleDefinition */

/** @param {number} sec */
function mmss(sec) {
  return `${String(Math.floor(Math.max(0, sec) / 60)).padStart(2, "0")}:${String(Math.max(0, sec) % 60).padStart(2, "0")}`;
}

/** @param {any} plugin @param {string} operation @param {unknown} error */
function logViewError(plugin, operation, error) {
  console.error("Pomodoro AIO 视图操作失败", {
    operation,
    sessionId: plugin?.runtime?.sessionId || null,
    step: "ui",
    error: String(error instanceof Error ? error.message : error || "unknown error")
  });
}

/** @param {HTMLElement} button @param {string} icon @param {string} label */
function setButtonIcon(button, icon, label) {
  if (button.dataset.pmdIcon !== icon) {
    setIcon(button, icon);
    button.dataset.pmdIcon = icon;
  }
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

/** @param {any} leaf @param {any} plugin */
class PomodoroView extends ItemView {
  static VIEW_TYPE = "pomodoro-aio-view";
  /** @param {any} leaf @param {any} plugin */
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    /** @type {Array<() => void>} */
    this.disposers = [];
    /** @type {Array<Record<string, any>>} */
    this._workspaceCommands = [];
    /** @type {string[]} */
    this._todayUnchecked = [];
    /** @type {Array<ObsidianElement>} */
    this._taskLists = [];
    this._taskListPrefix = `pmd-tasks-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    /** @type {string} */
    this._editorSignature = "";
    /** @type {ReturnType<typeof createModuleDraft> | null} */
    this._moduleDraft = null;
    this._todaySumCache = 0;
  }
  getViewType() { return PomodoroView.VIEW_TYPE; }
  getDisplayText() { return "循环工作"; }
  getIcon() { return "clock"; }

  async onOpen() {
    this._moduleDraft = null;
    const root = this.containerEl;
    root.empty();
    root.addClass("pmd-root");
    const head = root.createDiv({ cls: "pmd-head" });
    const ring = head.createDiv({ cls: "pmd-ring" });
    ring.innerHTML = `<svg class="pmd-ring-svg" width="72" height="72" viewBox="0 0 72 72" aria-hidden="true"><g transform="rotate(-90 36 36)"><circle cx="36" cy="36" r="30" class="pmd-ring-track"></circle><circle cx="36" cy="36" r="30" class="pmd-ring-prog" stroke-dasharray="${2 * Math.PI * 30}" stroke-dashoffset="${2 * Math.PI * 30}"></circle></g></svg><div class="pmd-ring-text">0/8</div>`;
    const ringText = /** @type {HTMLElement} */ (ring.querySelector(".pmd-ring-text"));
    const ringProgress = /** @type {SVGElement} */ (ring.querySelector(".pmd-ring-prog"));
    ring.setAttribute("role", "progressbar");
    ring.setAttribute("aria-label", "今日番茄进度");
    ring.setAttribute("aria-valuemin", "0");
    const timer = head.createDiv({ cls: "pmd-time", text: mmss(this.plugin.getLeftSec()), attr: { role: "timer", "aria-label": "剩余时间" } });
    const phase = head.createDiv({ cls: "pmd-state", text: "待机" });
    const todayButton = head.createEl("button", { cls: "pmd-btn pmd-icon-button", attr: { type: "button" } });
    setButtonIcon(todayButton, "file-text", "打开当日日记");
    todayButton.onclick = () => this.plugin.runUserCommand(() => this.plugin.openToday());
    const projectButton = head.createEl("button", { cls: "pmd-btn pmd-icon-button pmd-project-entry", attr: { type: "button" } });
    setButtonIcon(projectButton, "folder", "推进中的项目");
    projectButton.onclick = () => this.plugin.activateProjectsView(this.leaf);

    const statusLine = root.createDiv({ cls: "pmd-status-line", attr: { "aria-live": "polite" } });

    const actions = root.createDiv({ cls: "pmd-actions" });
    const startButton = actions.createEl("button", { cls: "pmd-btn pmd-icon-button pmd-start-button", attr: { type: "button" } });
    setButtonIcon(startButton, "play", "开始");
    const pauseButton = actions.createEl("button", { cls: "pmd-btn", text: "暂停", attr: { type: "button" } });
    const completeSegmentButton = actions.createEl("button", { cls: "pmd-btn", text: "完成本段", attr: { type: "button" } });
    const completeTaskButton = actions.createEl("button", { cls: "pmd-btn pmd-btn-secondary", text: "完成事情", attr: { type: "button" } });
    const resetButton = actions.createEl("button", { cls: "pmd-btn", text: "重置", attr: { type: "button" } });
    const refreshButton = actions.createEl("button", { cls: "pmd-btn pmd-icon-button", attr: { type: "button" } });
    setButtonIcon(refreshButton, "refresh-cw", "刷新");
    const quickCaptureButton = actions.createEl("button", { cls: "pmd-btn pmd-icon-button", attr: { type: "button", "aria-expanded":"false", "aria-controls":"pmd-quick-capture" } });
    setButtonIcon(quickCaptureButton, "pencil", "快速捕捉");

    const runtimeStats = root.createDiv({ cls: "pmd-meta" });
    const footer = root.createDiv({ cls: "pmd-footer" });
    footer.appendChild(actions);
    const editorHeading = footer.createDiv({ cls: "pmd-editor-heading" });
    const editModeButton = editorHeading.createEl("button", { cls:"pmd-btn pmd-icon-button pmd-settings-button", attr:{ type:"button" } });
    setButtonIcon(editModeButton, "settings", "设置工作与休息模块");
    const editToolbar = editorHeading.createDiv({ cls:"pmd-actions pmd-edit-toolbar pmd-hidden" });
    const cancelEditButton = editToolbar.createEl("button", { cls:"pmd-btn pmd-btn-secondary", text:"取消", attr:{ type:"button" } });
    const saveEditButton = editToolbar.createEl("button", { cls:"pmd-btn pmd-btn-primary", text:"保存", attr:{ type:"button" } });
    const editor = root.createDiv({ cls: "pmd-module-editor" });
    const moduleList = editor.createDiv({ cls: "pmd-module-list" });
    const addActions = editor.createDiv({ cls: "pmd-actions pmd-add-module-actions pmd-hidden" });
    const addWorkButton = addActions.createEl("button", { cls: "pmd-btn", text: "+ 工作", attr: { type: "button" } });
    const addRestButton = addActions.createEl("button", { cls: "pmd-btn", text: "+ 休息", attr: { type: "button" } });
    const presetEditor = editor.createDiv({ cls:"pmd-rest-presets pmd-hidden" });
    presetEditor.createEl("label", { text:"休息事项预设（每行一项）", attr:{ for:"pmd-rest-presets-input" } });
    const presetInput = presetEditor.createEl("textarea", { cls:"pmd-input", attr:{ id:"pmd-rest-presets-input", rows:"4", placeholder:"例如：NSDR 非睡眠深度休息" } });
    const editStatus = editor.createDiv({ cls:"pmd-edit-status", attr:{ role:"status", "aria-live":"polite" } });
    const editorNote = editor.createDiv({ cls: "pmd-snapshot-note pmd-hidden", text: "本段按开始时设置运行；这里的修改用于后续模块执行。" });

    const capture = root.createDiv({ cls: "pmd-capture pmd-hidden", attr:{ id:"pmd-quick-capture" } });
    const captureRow = capture.createDiv({ cls: "pmd-row-inline" });
    const captureInput = captureRow.createEl("input", { cls: "pmd-input", attr: { type: "text", placeholder: "记录一个待办或想法", "aria-label": "快速记录内容" } });
    const captureButton = captureRow.createEl("button", { cls: "pmd-btn", text: "保存", attr: { type: "button" } });
    const captureStatus = capture.createDiv({ cls: "pmd-capture-status", attr: { role: "status", "aria-live": "polite" } });
    let captureBusy = false;
    quickCaptureButton.onclick = () => {
      const open = capture.classList.toggle("pmd-hidden") === false;
      quickCaptureButton.setAttribute("aria-expanded", String(open));
      if (open) captureInput.focus();
    };
    const submitCapture = async () => {
      if (captureBusy || !captureInput.value.trim()) return;
      captureBusy = true;
      captureButton.disabled = true;
      captureStatus.setText("正在保存…");
      try {
        await this.plugin.quickCapture(captureInput.value.trim(), "todo");
        captureInput.value = "";
        captureStatus.setText("已保存到快速记录区域");
      } catch (error) {
        captureStatus.setText("保存失败，请检查当日日记设置");
        logViewError(this.plugin, "quick-capture", error);
      } finally {
        captureBusy = false;
        captureButton.disabled = false;
      }
    };
    captureButton.onclick = submitCapture;
    captureInput.onkeydown = event => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void submitCapture(); }
      if (event.key === "Escape") { capture.classList.add("pmd-hidden"); quickCaptureButton.setAttribute("aria-expanded", "false"); quickCaptureButton.focus(); }
    };
    root.appendChild(footer);

    /** @param {any} command */
    const commandTitle = command => workspaceLayoutLabel(command) || command?.name || command?.id || "工作区";
    /** @param {HTMLInputElement} input */
    const openDatalist = input => {
      const previous = input.value;
      const wrapper = !previous ? input.closest(".pmd-input-wrap") : null;
      wrapper?.classList.add("pmd-datalist-opening");
      input.value = `${previous}\u200B`;
      input.dispatchEvent(new Event("input", { bubbles:true }));
      window.setTimeout(() => {
        input.value = previous;
        input.dispatchEvent(new Event("input", { bubbles:true }));
        wrapper?.classList.remove("pmd-datalist-opening");
      }, 0);
    };
    const fillTaskLists = () => this._taskLists.forEach(list => {
      list.empty();
      this._todayUnchecked.forEach(task => list.createEl("option", { attr:{ value:task } }));
    });
    const refreshEditor = (snap = this.plugin.snapshot(), force = false) => {
      const editing = !!this._moduleDraft;
      /** @type {Record<string, any>[]} */
      const modules = this._moduleDraft ? this._moduleDraft.modules : (Array.isArray(snap.settings.modules) ? snap.settings.modules : []);
      const signature = JSON.stringify(modules);
      projectButton.classList.toggle("pmd-hidden", snap.settings.enableProjects !== true);
      root.classList.toggle("is-configuring", editing);
      refreshButton.classList.toggle("pmd-hidden", editing);
      quickCaptureButton.classList.toggle("pmd-hidden", editing);
      actions.classList.toggle("pmd-hidden", [...actions.children].every(button => button.classList.contains("pmd-hidden")));
      if (editing) {
        capture.classList.add("pmd-hidden");
        quickCaptureButton.setAttribute("aria-expanded", "false");
      }
      editModeButton.classList.toggle("pmd-hidden", editing);
      addActions.classList.toggle("pmd-hidden", !editing);
      presetEditor.classList.toggle("pmd-hidden", !editing);
      editToolbar.classList.toggle("pmd-hidden", !editing);
      if (!force && (editing || signature === this._editorSignature)) return;
      this._editorSignature = signature;
      moduleList.empty();
      this._taskLists = [];
      if (!modules.length) moduleList.createDiv({ cls:"pmd-empty", text:editing ? "添加工作或休息模块，组成你的序列。" : "点击设置，添加工作或休息模块。" });
      modules.forEach((module, index) => {
        const row = moduleList.createDiv({ cls:`pmd-module-row is-${module.type}${editing ? " is-editing" : ""}`, attr:{ "data-module-id":module.id } });
        const role = row.createDiv({ cls:"pmd-module-role" });
        const roleLabel = role.createEl("button", { cls:"pmd-module-select", text:module.type === "work" ? "工作" : "休息",
          attr:{ type:"button", title:editing ? "正在编辑模块" : "双击设为当前模块", "aria-label":`${editing ? "正在编辑" : "双击选择"}第 ${index + 1} 段${module.type === "work" ? "工作" : "休息"}` } });
        if (editing) roleLabel.disabled = true;
        else {
          const chooseModule = (/** @type {Event} */ event) => this.plugin.runUserCommand(() => this.plugin.selectModule(index), event);
          roleLabel.ondblclick = chooseModule;
          roleLabel.onclick = event => { if (event.detail === 0) chooseModule(event); };
        }
        const fields = row.createDiv({ cls:"pmd-module-fields" });
        const draft = this._moduleDraft;
        /** @param {Partial<ModuleDefinition>} patch */
        const applyField = patch => {
          if (draft) Object.assign(module, patch);
          else this.plugin.runUserCommand(() => this.plugin.updateModule(module.id, patch));
        };
        if (editing && draft) {
          const tools = role.createDiv({ cls:"pmd-module-tools" });
          const grip = tools.createEl("button", { cls:"pmd-module-grip", text:"↕", attr:{ type:"button", title:"拖动排序，或用上下方向键移动", "aria-label":`排序第 ${index + 1} 个模块`, draggable:"true" } });
          const remove = tools.createEl("button", { cls:"pmd-module-remove", text:"×", attr:{ type:"button", title:"删除模块", "aria-label":`删除第 ${index + 1} 个模块` } });
          remove.onclick = () => { draft.modules = draft.modules.filter(item => item.id !== module.id); refreshEditor(this.plugin.snapshot(), true); };
          /** @param {number} target */
          const moveTo = target => {
            const from = draft.modules.findIndex(item => item.id === module.id);
            if (from < 0 || target < 0 || target >= draft.modules.length || from === target) return;
            const [moving] = draft.modules.splice(from, 1);
            draft.modules.splice(target, 0, moving);
            refreshEditor(this.plugin.snapshot(), true);
          };
          grip.onkeydown = event => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              moveTo(index + (event.key === "ArrowUp" ? -1 : 1));
              const movedRow = [...moduleList.querySelectorAll(".pmd-module-row")].find(item => item.getAttribute("data-module-id") === module.id);
              /** @type {HTMLElement | null} */ (movedRow?.querySelector(".pmd-module-grip"))?.focus();
            }
          };
          grip.ondragstart = event => {
            row.classList.add("is-dragging");
            event.dataTransfer?.setData("text/plain", module.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          };
          grip.ondragend = () => row.classList.remove("is-dragging");
          row.ondragover = event => { event.preventDefault(); row.classList.add("is-drop-target"); };
          row.ondragleave = () => row.classList.remove("is-drop-target");
          row.ondrop = event => {
            event.preventDefault(); row.classList.remove("is-drop-target");
            const movingId = event.dataTransfer?.getData("text/plain");
            const from = draft.modules.findIndex(item => item.id === movingId);
            if (from < 0 || movingId === module.id) return;
            const [moving] = draft.modules.splice(from, 1);
            draft.modules.splice(index, 0, moving);
            refreshEditor(this.plugin.snapshot(), true);
          };
        }
        const nameWrap = fields.createDiv({ cls:"pmd-module-name" });
        const nameInputWrap = nameWrap.createDiv({ cls:"pmd-input-wrap" });
        const name = nameInputWrap.createEl("input", { cls:"pmd-input", attr:{ type:"text", placeholder:module.type === "work" ? "输入/选择事情（未勾选待办）" : "输入/选择休息事项", "aria-label":`第 ${index + 1} 段${module.type === "work" ? "工作事情" : "休息事项"}` } });
        name.value = (module.type === "work" && module.name === "工作") || (module.type === "rest" && module.name === "休息") ? "" : module.name || "";
        const listId = `${this._taskListPrefix}-${index}`;
        name.setAttribute("list", listId);
        const list = nameInputWrap.createEl("datalist", { attr:{ id:listId } });
        if (module.type === "work") this._taskLists.push(list);
        else {
          const fillRestList = () => {
            list.empty();
            const seen = new Set();
            String(draft ? presetInput.value : (this.plugin.settings.restPresets || []).join("\n")).split(/\r?\n/).map(item => item.trim()).filter(item => {
              if (!item || seen.has(item)) return false;
              seen.add(item); return true;
            }).forEach(item => list.createEl("option", { attr:{ value:item } }));
          };
          fillRestList();
          name.addEventListener("focus", fillRestList);
        }
        name.addEventListener("focus", () => openDatalist(name));
        name.addEventListener("click", () => openDatalist(name));
        name.oninput = () => { if (draft) module.name = name.value.replace(/\u200B/g, ""); };
        name.onchange = () => { if (!draft) applyField({ name:name.value.replace(/\u200B/g, "").trim() }); };
        const clearName = nameInputWrap.createEl("button", { cls:"pmd-clear", text:"×", attr:{ type:"button", title:"清空名称" } });
        clearName.onclick = () => { name.value = ""; applyField({ name:"" }); name.focus(); };
        if (module.type === "work" && module.name && module.name !== "工作") {
          const complete = nameWrap.createEl("button", { cls:"pmd-complete-inline", text:"完成", attr:{ type:"button", title:"完成事情并勾选日记待办" } });
          complete.disabled = editing;
          complete.onclick = event => this.plugin.runUserCommand(() => this.plugin.completeTask({ moduleId:module.id }), event);
        }
        const durationWrap = fields.createDiv({ cls:"pmd-module-duration" });
        const duration = durationWrap.createEl("input", { cls:"pmd-cycle-min", attr:{ type:"number", min:"1", step:"1", "aria-label":`第 ${index + 1} 段时长（分钟）` } });
        duration.value = String(module.durationMin);
        duration.oninput = () => { if (draft) module.durationMin = Number(duration.value); };
        duration.onchange = () => {
          if (draft) return;
          const minutes = Number(duration.value);
          if (Number.isFinite(minutes) && minutes >= 1) applyField({ durationMin:minutes });
          else { duration.value = String(module.durationMin); editStatus.setText("时长须大于零"); }
        };
        durationWrap.createSpan({ cls:"pmd-cycle-unit", text:"分钟" });
        if (module.type === "work") {
          const workspaceWrap = fields.createDiv({ cls:"pmd-input-wrap pmd-module-workspace" });
          const workspaceListId = `${this._taskListPrefix}-workspace-${index}`;
          const workspace = workspaceWrap.createEl("input", { cls:"pmd-cycle-workspace", attr:{ type:"text", list:workspaceListId, placeholder:"筛选/选择布局", "aria-label":`第 ${index + 1} 段工作区布局` } });
          const workspaceList = workspaceWrap.createEl("datalist", { attr:{ id:workspaceListId } });
          this._workspaceCommands.forEach(command => workspaceList.createEl("option", { attr:{ value:commandTitle(command) } }));
          const selected = this._workspaceCommands.find(command => command.id === module.workspaceCommandId);
          workspace.value = selected ? commandTitle(selected) : "";
          workspace.onfocus = () => openDatalist(workspace);
          workspace.oninput = () => {
            const value = workspace.value.replace(/\u200B/g, "").trim();
            const hit = this._workspaceCommands.find(command => commandTitle(command) === value);
            if (draft) {
              module.invalidWorkspace = !!value && !hit;
              module.workspaceCommandId = hit?.id || "";
            }
          };
          workspace.onchange = () => {
            if (draft) return;
            const value = workspace.value.replace(/\u200B/g, "").trim();
            const hit = this._workspaceCommands.find(command => commandTitle(command) === value);
            if (value && !hit) { workspace.value = selected ? commandTitle(selected) : ""; editStatus.setText("工作区须从候选中选择"); return; }
            applyField({ workspaceCommandId:hit?.id || "" });
          };
          const clearWorkspace = workspaceWrap.createEl("button", { cls:"pmd-clear", text:"×", attr:{ type:"button", title:"清空工作区" } });
          clearWorkspace.onclick = () => { workspace.value = ""; if (draft) module.invalidWorkspace = false; applyField({ workspaceCommandId:"" }); workspace.focus(); };
        }
        const blackout = fields.createEl("button", { cls:"pmd-blackout-option pmd-module-blackout", attr:{ type:"button", "aria-label":`第 ${index + 1} 段执行时黑屏`, "aria-pressed":String(module.blackout === true) } });
        blackout.createSpan({ cls:"pmd-blackout-check", attr:{ "aria-hidden":"true" } });
        blackout.createSpan({ text:"执行时黑屏" });
        blackout.onclick = () => {
          const next = blackout.getAttribute("aria-pressed") !== "true";
          blackout.setAttribute("aria-pressed", String(next));
          applyField({ blackout:next });
        };
      });
      fillTaskLists();
    };

    /** @param {"work" | "rest"} type */
    const addDraftModule = type => {
      if (!this._moduleDraft) return;
      this._moduleDraft.modules.push(normalizeModuleDefinition({ type, name:type === "rest" ? "休息" : "工作", durationMin:type === "rest" ? 5 : 25 }));
      refreshEditor(this.plugin.snapshot(), true);
    };
    addWorkButton.onclick = () => addDraftModule("work");
    addRestButton.onclick = () => addDraftModule("rest");
    editModeButton.onclick = () => {
      this._moduleDraft = createModuleDraft(this.plugin.settings);
      presetInput.value = this._moduleDraft.restPresetsText;
      editStatus.setText("编辑仅在点击保存后生效");
      refreshEditor(this.plugin.snapshot(), true);
      onState(this.plugin.snapshot());
    };
    cancelEditButton.onclick = () => {
      this._moduleDraft = null;
      editStatus.setText("");
      refreshEditor(this.plugin.snapshot(), true);
      onState(this.plugin.snapshot());
    };
    presetInput.oninput = () => {
      if (this._moduleDraft) this._moduleDraft.restPresetsText = presetInput.value;
    };
    saveEditButton.onclick = async () => {
      const draft = this._moduleDraft;
      if (!draft) return;
      saveEditButton.disabled = true;
      draft.restPresetsText = presetInput.value;
      editStatus.setText("正在保存…");
      try {
        await this.plugin.saveModuleDraft(draft);
        this._moduleDraft = null;
        editStatus.setText("设置已保存");
        refreshEditor(this.plugin.snapshot(), true);
        onState(this.plugin.snapshot());
      } catch (error) {
        editStatus.setText(error instanceof Error ? error.message : "保存失败，请稍后重试");
        logViewError(this.plugin, "module-draft-save", error);
      } finally {
        saveEditButton.disabled = false;
      }
    };
    startButton.onclick = () => this.plugin.runUserCommand(async () => {
      if (this._moduleDraft) { editStatus.setText("请先保存或取消设置"); return false; }
      const snap = this.plugin.snapshot();
      if (snap.runtime.status === TIMER_STATUS.PAUSED) return this.plugin.togglePause();
      if (snap.runtime.moduleRun || snap.runtime.attention) return this.plugin.startPendingStage();
      return this.plugin.startSequence();
    });
    pauseButton.onclick = () => this.plugin.runUserCommand(() => this.plugin.togglePause());
    completeSegmentButton.onclick = () => this.plugin.runUserCommand(() => this.plugin.completeCurrentModule());
    /** @param {any} snap */
    const displayedModule = snap => {
      const runtime = snap.runtime || this.plugin.runtime;
      const modules = snap.settings?.modules || this.plugin.settings.modules || [];
      const queued = runtime.status === TIMER_STATUS.AWAITING ? runtime.attention?.moduleRun : null;
      return runtime.moduleRun || (queued ? modules.find((/** @type {ModuleDefinition} */ module) => module.id === queued.moduleId) || queued : null);
    };
    completeTaskButton.onclick = () => {
      const run = displayedModule(this.plugin.snapshot());
      if (run?.type === "work") this.plugin.runUserCommand(() => this.plugin.completeTask({ moduleId: run.moduleId || run.id }));
    };
    resetButton.onclick = () => this.plugin.runUserCommand(() => this.plugin.reset());

    /** @param {any} snap */
    const onState = snap => {
      const settings = snap.settings || this.plugin.settings;
      const runtime = snap.runtime || this.plugin.runtime;
      const modules = Array.isArray(settings.modules) ? settings.modules : [];
      const run = displayedModule(snap);
      const running = [TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED].includes(runtime.status);
      const pending = !!runtime.attention && !runtime.attention.nextStarted;
      const active = !!run && runtime.status !== TIMER_STATUS.IDLE;
      const selectedId = runtime.status === TIMER_STATUS.IDLE
        ? runtime.selectedModuleId || modules[runtime.currentModuleIndex || 0]?.id
        : runtime.attention?.moduleRun?.moduleId || runtime.moduleRun?.moduleId;
      timer.setText(mmss(runtime.leftSec ?? this.plugin.getLeftSec()));
      phase.setText(run ? `${run.type === "work" ? "工作" : "休息"}${pending ? " · 待开始" : ""}` : "待机");
      statusLine.classList.toggle("pmd-hidden", runtime.status === TIMER_STATUS.RUNNING || runtime.status === TIMER_STATUS.IDLE);
      statusLine.setText(runtime.status === TIMER_STATUS.PAUSED ? "已暂停" : runtime.status === TIMER_STATUS.AWAITING ? "等待确认" : runtime.status === TIMER_STATUS.SETTLING ? "正在结算" : runtime.status === TIMER_STATUS.FAILED ? "需要恢复结算" : "");
      const dailyGoal = Number(settings.dailyGoal) > 0 ? Number(settings.dailyGoal) : 8;
      const todaySum = this._todaySumCache || 0;
      ringText.textContent = `${formatTomatoNumber(todaySum)}/${dailyGoal}`;
      ring.setAttribute("aria-valuemax", String(dailyGoal));
      ring.setAttribute("aria-valuenow", String(todaySum));
      ringProgress.setAttribute("stroke-dashoffset", String(2 * Math.PI * 30 * (1 - Math.min(todaySum / dailyGoal, 1))));
      runtimeStats.setText(`今日累计：${formatTomatoNumber(todaySum)}🍅 · 本次工作 ${runtime.completedWorkCount || 0} 段 · 休息 ${runtime.completedRestCount || 0} 段 · 完整循环 ${runtime.completedLoopCount || 0} 次`);
      setButtonIcon(startButton, "play", runtime.status === TIMER_STATUS.PAUSED ? "继续" : pending ? "开始下一段" : active ? "继续" : "开始");
      startButton.classList.toggle("pmd-hidden", !!this._moduleDraft || runtime.status === TIMER_STATUS.RUNNING || runtime.status === TIMER_STATUS.SETTLING || runtime.status === TIMER_STATUS.FAILED);
      startButton.disabled = !!this._moduleDraft || (!modules.length && runtime.status === TIMER_STATUS.IDLE);
      pauseButton.classList.toggle("pmd-hidden", runtime.status !== TIMER_STATUS.RUNNING);
      completeSegmentButton.classList.toggle("pmd-hidden", !running || runtime.status === TIMER_STATUS.SETTLING || runtime.status === TIMER_STATUS.FAILED);
      completeTaskButton.classList.toggle("pmd-hidden", !active || run?.type !== "work" || !String(run.name || "").trim());
      resetButton.classList.toggle("pmd-hidden", runtime.status === TIMER_STATUS.IDLE && !runtime.attention);
      editorNote.classList.toggle("pmd-hidden", !this._moduleDraft || (!active && !pending));
      refreshEditor(snap);
      moduleList.querySelectorAll(".pmd-module-row").forEach(row => {
        const isCurrent = row.getAttribute("data-module-id") === selectedId;
        row.classList.toggle("is-current", isCurrent);
        row.querySelector(".pmd-module-select")?.setAttribute("aria-pressed", String(isCurrent));
      });
    };

    try {
      this._workspaceCommands = this.plugin.getWorkspaceLayoutCommands();
    } catch (error) { logViewError(this.plugin, "load-options", error); }
    onState(this.plugin.snapshot());
    this.app.workspace.on("pomodoro:aio-state", onState);
    this.disposers.push(() => this.app.workspace.off("pomodoro:aio-state", onState));
    const refreshToday = async () => {
      refreshButton.disabled = true;
      try {
        const today = await this.plugin.refreshTodaySnapshot();
        this._todaySumCache = Number(today?.sum) || 0;
        this._todayUnchecked = Array.isArray(today?.unchecked) ? today.unchecked : [];
        fillTaskLists();
        onState(this.plugin.snapshot());
        setButtonIcon(refreshButton, "refresh-cw", "已刷新");
      } catch (error) {
        setButtonIcon(refreshButton, "refresh-cw", "刷新失败");
        logViewError(this.plugin, "daily-refresh", error);
      } finally {
        refreshButton.disabled = false;
        window.setTimeout(() => { if (refreshButton.isConnected) setButtonIcon(refreshButton, "refresh-cw", "刷新"); }, 1200);
      }
    };
    refreshButton.onclick = refreshToday;
    await refreshToday();
    if (typeof this.app.vault?.on === "function") {
      /** @type {number | null} */
      let refreshTimer = null;
      const ref = this.app.vault.on("modify", (/** @type {{path?:string}} */ file) => {
        if (file?.path !== this.plugin.todayFilePath()) return;
        if (refreshTimer) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(refreshToday, 180);
      });
      this.disposers.push(() => {
        if (refreshTimer) window.clearTimeout(refreshTimer);
        this.app.vault.offref(ref);
      });
    }
    try { this.plugin.setViewWasOpen(true); } catch (error) { logViewError(this.plugin, "view-lifecycle", error); }
    this.disposers.push(() => {
      try { this.plugin.setViewWasOpen(false); } catch (error) { logViewError(this.plugin, "view-lifecycle", error); }
    });
  }

  async onClose() {
    this.disposers.forEach(dispose => { try { dispose(); } catch (error) { logViewError(this.plugin, "view-lifecycle", error); } });
    this.disposers.length = 0;
  }
}

module.exports = { PomodoroView };
