const { ItemView } = require("obsidian");
const { TIMER_STATUS } = require("../core/timer");
const { formatTomatoNumber } = require("../core/validation");
const { workspaceLayoutLabel } = require("../integrations/workspaces-plus");
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
    this._todaySumCache = 0;
  }
  getViewType() { return PomodoroView.VIEW_TYPE; }
  getDisplayText() { return "循环工作"; }
  getIcon() { return "clock"; }

  async onOpen() {
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
    const todayButton = head.createEl("button", { cls: "pmd-btn pmd-btn-secondary", text: "打开当日日记", attr: { type: "button" } });
    todayButton.onclick = () => this.plugin.runUserCommand(() => this.plugin.openToday());
    const projectButton = head.createEl("button", { cls: "pmd-btn pmd-btn-secondary pmd-project-entry", text: "推进中的项目", attr: { type: "button" } });
    projectButton.onclick = () => this.plugin.activateProjectsView();

    const statusLine = root.createDiv({ cls: "pmd-status-line", attr: { "aria-live": "polite" } });
    const currentSummary = root.createDiv({ cls: "pmd-current-summary pmd-hidden" });
    const currentTitle = currentSummary.createDiv({ cls: "pmd-current-title" });
    const currentMeta = currentSummary.createDiv({ cls: "pmd-current-meta" });
    const nextLine = currentSummary.createDiv({ cls: "pmd-next-module" });

    const actions = root.createDiv({ cls: "pmd-actions" });
    const startButton = actions.createEl("button", { cls: "pmd-btn pmd-btn-primary", text: "开始序列", attr: { type: "button" } });
    const pauseButton = actions.createEl("button", { cls: "pmd-btn", text: "暂停", attr: { type: "button" } });
    const completeSegmentButton = actions.createEl("button", { cls: "pmd-btn", text: "完成本段", attr: { type: "button" } });
    const completeTaskButton = actions.createEl("button", { cls: "pmd-btn pmd-btn-secondary", text: "完成事情", attr: { type: "button" } });
    const resetButton = actions.createEl("button", { cls: "pmd-btn", text: "重置", attr: { type: "button" } });
    const refreshButton = actions.createEl("button", { cls: "pmd-btn pmd-btn-secondary", text: "刷新", attr: { type: "button" } });
    const quickCaptureButton = actions.createEl("button", { cls: "pmd-btn pmd-btn-secondary", text: "快速捕捉", attr: { type: "button", "aria-expanded":"false", "aria-controls":"pmd-quick-capture" } });

    const runtimeStats = root.createDiv({ cls: "pmd-meta" });

    const editor = root.createDiv({ cls: "pmd-module-editor" });
    const editorHeading = editor.createDiv({ cls: "pmd-editor-heading" });
    editorHeading.createEl("h3", { text: "工作与休息序列" });
    const moduleList = editor.createDiv({ cls: "pmd-module-list" });
    const addActions = editor.createDiv({ cls: "pmd-actions pmd-add-module-actions" });
    const addWorkButton = addActions.createEl("button", { cls: "pmd-btn", text: "+ 工作", attr: { type: "button" } });
    const addRestButton = addActions.createEl("button", { cls: "pmd-btn", text: "+ 休息", attr: { type: "button" } });
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
    /** @type {Set<Promise<boolean>>} */
    const pendingEdits = new Set();
    /** @param {Promise<boolean>} promise */
    const trackEdit = promise => {
      pendingEdits.add(promise);
      void promise.finally(() => pendingEdits.delete(promise));
      return promise;
    };
    /** @param {()=>Promise<any>} action @param {string} success */
    const edit = (action, success) => trackEdit((async () => {
      try {
        const result = await action();
        if (result === false) throw new Error("edit rejected");
        editStatus.setText(success);
        return true;
      } catch (error) {
        editStatus.setText("保存失败，请检查插件设置或稍后重试");
        logViewError(this.plugin, "module-edit", error);
        return false;
      }
    })());
    const refreshEditor = (snap = this.plugin.snapshot()) => {
      const modules = Array.isArray(snap.settings.modules) ? snap.settings.modules : [];
      projectButton.classList.toggle("pmd-hidden", snap.settings.enableProjects !== true);
      const signature = JSON.stringify(modules);
      if (signature === this._editorSignature) return;
      this._editorSignature = signature;
      moduleList.empty();
      this._taskLists = [];
      /** @type {ModuleDefinition[]} */
      const definitions = modules;
      definitions.forEach((module, index) => {
        const row = moduleList.createDiv({ cls: `pmd-module-row is-${module.type}`, attr: { "data-module-id": module.id, "data-index": String(index) } });
        const role = row.createDiv({ cls:"pmd-module-role" });
        const roleLabel = role.createEl("button", { cls:"pmd-module-select",
          text:module.type === "work" ? "工作" : "休息",
          attr:{ type:"button", title:"双击设为当前模块", "aria-label":`双击选择第 ${index + 1} 段${module.type === "work" ? "工作" : "休息"}` } });
        const chooseModule = (/** @type {Event} */ event) => this.plugin.runUserCommand(async () => {
          if ((await Promise.all([...pendingEdits])).some(saved => !saved)) return false;
          return this.plugin.selectModule(index);
        }, event);
        roleLabel.ondblclick = chooseModule;
        roleLabel.onclick = event => { if (event.detail === 0) chooseModule(event); };
        const grip = role.createSpan({ cls:"pmd-module-grip", text:"↕", attr:{ title:"拖动调整顺序", "aria-label":`拖动第 ${index + 1} 个模块排序`, draggable:"true" } });
        const fields = row.createDiv({ cls: "pmd-module-fields" });
        const nameWrap = fields.createDiv({ cls: "pmd-input-wrap pmd-module-name" });
        const name = nameWrap.createEl("input", { cls: "pmd-input", attr: { type: "text", placeholder: module.type === "work" ? "输入/选择事情（仅显示未勾选待办）" : "休息方式", "aria-label": module.type === "work" ? `第 ${index + 1} 段工作事情` : `第 ${index + 1} 段休息方式` } });
        name.value = module.type === "work" && module.name === "工作" ? "" : module.name || "";
        const listId = `${this._taskListPrefix}-${index}`;
        if (module.type === "work") {
          name.setAttribute("list", listId);
          const list = nameWrap.createEl("datalist", { attr:{ id:listId } });
          this._taskLists.push(list);
          name.addEventListener("focus", () => openDatalist(name));
          name.addEventListener("click", () => openDatalist(name));
        }
        let nameSave = Promise.resolve(true);
        /** @type {string | null} */
        let pendingNameValue = null;
        const saveName = () => {
          const value = name.value.trim();
          if (pendingNameValue === value) return nameSave;
          const current = this.plugin.settings.modules.find((/** @type {ModuleDefinition} */ item) => item.id === module.id)?.name || "";
          if (value === current) return nameSave;
          pendingNameValue = value;
          nameSave = trackEdit(this.plugin.updateModule(module.id, { name:value }).then((/** @type {boolean} */ result) => {
            editStatus.setText(result ? "名称已保存" : "保存失败，请重试");
            return result === true;
          }).catch((/** @type {unknown} */ error) => {
            editStatus.setText("保存失败，请检查插件设置或稍后重试");
            logViewError(this.plugin, "module-name", error);
            return false;
          }).finally(() => {
            if (pendingNameValue === value) pendingNameValue = null;
          }));
          return nameSave;
        };
        name.onchange = () => { void saveName(); };
        name.onkeydown = event => {
          if (event.key === "Escape") {
            event.preventDefault();
            name.value = "";
            void saveName();
          }
        };
        const clearName = nameWrap.createEl("button", { cls:"pmd-clear", text:"×", attr:{ type:"button", title:"清空名称", "aria-label":`清空第 ${index + 1} 段名称` } });
        const clearNameAction = (/** @type {Event} */ event) => {
          event.preventDefault();
          name.value = "";
          void saveName();
          name.focus();
        };
        clearName.onpointerdown = clearNameAction;
        clearName.onclick = event => { if (event.detail === 0) clearNameAction(event); };
        if (module.type === "work") {
          const completeThing = nameWrap.createEl("button", {
            cls:"pmd-clear pmd-complete-thing", text:"完成",
            attr:{ type:"button", title:"完成事情并勾选日记待办", "aria-label":`完成第 ${index + 1} 段事情` }
          });
          const syncCompleteButton = () => {
            completeThing.disabled = !name.value.replace(/\u200B/g, "").trim();
            completeThing.title = completeThing.disabled ? "请先输入或选择日记待办" : "完成事情并勾选日记待办";
          };
          syncCompleteButton();
          name.addEventListener("input", syncCompleteButton);
          completeThing.onpointerdown = event => event.preventDefault();
          completeThing.onclick = event => this.plugin.runUserCommand(async () => {
            if (!(await saveName())) return false;
            return this.plugin.completeTask({ moduleId:module.id });
          }, event);
        }
        const durationWrap = fields.createDiv({ cls:"pmd-module-duration" });
        const duration = durationWrap.createEl("input", { cls: "pmd-cycle-min", attr: { type: "number", min: "1", step: "1", "aria-label": `第 ${index + 1} 段时长（分钟）` } });
        duration.value = String(module.durationMin || 25);
        duration.onchange = () => edit(() => this.plugin.updateModule(module.id, { durationMin: Math.max(1, Math.round(Number(duration.value) || 1)) }), "时长已保存");
        durationWrap.createSpan({ cls:"pmd-cycle-unit", text:"分钟" });

        if (module.type === "work") {
          const workspaceWrap = fields.createDiv({ cls:"pmd-input-wrap pmd-module-workspace" });
          const workspaceListId = `${this._taskListPrefix}-workspace-${index}`;
          const workspace = workspaceWrap.createEl("input", { cls:"pmd-cycle-workspace", attr:{ type:"text", list:workspaceListId, placeholder:"筛选/选择布局", "aria-label":`第 ${index + 1} 段工作区布局` } });
          const workspaceList = workspaceWrap.createEl("datalist", { attr:{ id:workspaceListId } });
          this._workspaceCommands.forEach(command => workspaceList.createEl("option", { attr:{ value:commandTitle(command) } }));
          const selectedWorkspace = this._workspaceCommands.find(command => command.id === module.workspaceCommandId);
          workspace.value = selectedWorkspace ? commandTitle(selectedWorkspace) : "";
          workspace.onfocus = () => openDatalist(workspace);
          workspace.onchange = () => {
            const hit = this._workspaceCommands.find(command => commandTitle(command) === workspace.value.trim());
            if (workspace.value.trim() && !hit) {
              workspace.value = selectedWorkspace ? commandTitle(selectedWorkspace) : "";
              editStatus.setText("请从工作区候选中选择布局");
              return;
            }
            edit(() => this.plugin.updateModule(module.id, { workspaceCommandId:hit?.id || "" }), "工作区已保存");
          };
          const clearWorkspace = workspaceWrap.createEl("button", { cls:"pmd-clear", text:"×", attr:{ type:"button", title:"清空工作区", "aria-label":`清空第 ${index + 1} 段工作区` } });
          clearWorkspace.onclick = () => { workspace.value = ""; workspace.onchange?.(new Event("change")); workspace.focus(); };
        }
        const blackout = fields.createEl("button", { cls:"pmd-blackout-option pmd-module-blackout", attr:{ type:"button", "aria-label":`第 ${index + 1} 段执行时黑屏`, "aria-pressed":String(module.blackout === true) } });
        blackout.createSpan({ cls:"pmd-blackout-check", attr:{ "aria-hidden":"true" } });
        blackout.createSpan({ text:"执行时黑屏" });
        blackout.onclick = () => edit(() => this.plugin.updateModule(module.id, { blackout:module.blackout !== true }), "黑屏设置已保存");
        const remove = role.createEl("button", { cls: "pmd-module-remove", text: "×", attr: { type: "button", title:"删除模块", "aria-label": `删除${module.type === "work" ? "工作" : "休息"}模块 ${index + 1}` } });
        remove.onclick = () => edit(() => this.plugin.removeModule(module.id), "模块已删除");
        grip.ondragstart = event => {
            row.classList.add("is-dragging");
            event.dataTransfer?.setData("text/plain", module.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        };
        grip.ondragend = () => row.classList.remove("is-dragging");
        row.ondragover = event => { event.preventDefault(); row.classList.add("is-drop-target"); };
        row.ondragleave = () => row.classList.remove("is-drop-target");
        row.ondrop = event => {
            event.preventDefault();
            row.classList.remove("is-drop-target");
            const movingId = event.dataTransfer?.getData("text/plain");
            if (!movingId || movingId === module.id) return;
            edit(() => this.plugin.moveModule(movingId, index), "顺序已保存");
        };
      });
      fillTaskLists();
    };

    addWorkButton.onclick = () => edit(() => this.plugin.addModule("work"), "工作模块已添加");
    addRestButton.onclick = () => edit(() => this.plugin.addModule("rest"), "休息模块已添加");
    startButton.onclick = () => this.plugin.runUserCommand(async () => {
      if ((await Promise.all([...pendingEdits])).some(saved => !saved)) return false;
      const snap = this.plugin.snapshot();
      if (snap.runtime.status === TIMER_STATUS.PAUSED) return this.plugin.togglePause();
      if (snap.runtime.moduleRun || snap.runtime.attention) return this.plugin.startPendingStage({ requestFullscreen: true });
      return this.plugin.startSequence({ requestFullscreen: true });
    });
    pauseButton.onclick = () => this.plugin.runUserCommand(() => this.plugin.togglePause());
    completeSegmentButton.onclick = () => this.plugin.runUserCommand(() => this.plugin.completeCurrentModule());
    completeTaskButton.onclick = () => {
      const run = this.plugin.runtime.moduleRun;
      if (run?.type === "work") this.plugin.runUserCommand(() => this.plugin.completeTask({ moduleId: run.moduleId }));
    };
    resetButton.onclick = () => this.plugin.runUserCommand(() => this.plugin.reset());

    /** @param {any} snap */
    const onState = snap => {
      const settings = snap.settings || this.plugin.settings;
      const runtime = snap.runtime || this.plugin.runtime;
      const modules = Array.isArray(settings.modules) ? settings.modules : [];
      const queued = runtime.status === TIMER_STATUS.AWAITING ? runtime.attention?.moduleRun : null;
      const run = runtime.moduleRun || (queued ? modules.find((/** @type {ModuleDefinition} */ module) => module.id === queued.moduleId) || queued : null);
      const next = runtime.nextModule;
      const running = [TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED].includes(runtime.status);
      const pending = !!runtime.attention && !runtime.attention.nextStarted;
      const active = !!run && runtime.status !== TIMER_STATUS.IDLE;
      const selectedId = runtime.status === TIMER_STATUS.IDLE
        ? runtime.selectedModuleId || modules[runtime.currentModuleIndex || 0]?.id
        : runtime.attention?.moduleRun?.moduleId || runtime.moduleRun?.moduleId;
      const selectedDefinition = modules.find((/** @type {ModuleDefinition} */ module) => module.id === selectedId);
      timer.setText(mmss(runtime.leftSec ?? this.plugin.getLeftSec()));
      phase.setText(run ? `${run.type === "work" ? "工作" : "休息"}${pending ? " · 待开始" : ""}` : "待机");
      currentTitle.setText(run?.name || (modules.length ? "序列已就绪" : "先添加工作或休息模块"));
      currentMeta.setText(run ? `${run.durationMin} 分钟${run.blackout ? " · 黑屏" : ""}` : `${modules.length} 个模块`);
      nextLine.setText(next ? `下一项：${next.type === "work" ? "工作" : "休息"} · ${next.name || "未命名"} · ${next.durationMin} 分钟` : "下一项：序列结束");
      statusLine.setText(runtime.status === TIMER_STATUS.RUNNING ? "正在执行" : runtime.status === TIMER_STATUS.PAUSED ? "已暂停" : runtime.status === TIMER_STATUS.AWAITING ? "等待确认" : runtime.status === TIMER_STATUS.SETTLING ? "正在结算" : runtime.status === TIMER_STATUS.FAILED ? "需要恢复结算" : selectedDefinition ? `当前选择：${selectedDefinition.type === "work" ? "工作" : "休息"} · ${selectedDefinition.name}` : "待机");
      const dailyGoal = Number(settings.dailyGoal) > 0 ? Number(settings.dailyGoal) : 8;
      const todaySum = this._todaySumCache || 0;
      ringText.textContent = `${formatTomatoNumber(todaySum)}/${dailyGoal}`;
      ring.setAttribute("aria-valuemax", String(dailyGoal));
      ring.setAttribute("aria-valuenow", String(todaySum));
      ringProgress.setAttribute("stroke-dashoffset", String(2 * Math.PI * 30 * (1 - Math.min(todaySum / dailyGoal, 1))));
      runtimeStats.setText(`今日累计：${formatTomatoNumber(todaySum)}🍅 · 本次工作 ${runtime.completedWorkCount || 0} 段 · 休息 ${runtime.completedRestCount || 0} 段 · 完整循环 ${runtime.completedLoopCount || 0} 次`);
      startButton.setText(runtime.status === TIMER_STATUS.PAUSED ? "继续" : pending ? "开始下一段" : active ? "继续序列" : "开始序列");
      startButton.classList.toggle("pmd-hidden", runtime.status === TIMER_STATUS.RUNNING || runtime.status === TIMER_STATUS.SETTLING || runtime.status === TIMER_STATUS.FAILED);
      startButton.disabled = !modules.length && runtime.status === TIMER_STATUS.IDLE;
      pauseButton.classList.toggle("pmd-hidden", runtime.status !== TIMER_STATUS.RUNNING);
      completeSegmentButton.classList.toggle("pmd-hidden", !running || runtime.status === TIMER_STATUS.SETTLING || runtime.status === TIMER_STATUS.FAILED);
      completeTaskButton.classList.toggle("pmd-hidden", !active || run?.type !== "work" || !String(run.name || "").trim());
      resetButton.classList.toggle("pmd-hidden", runtime.status === TIMER_STATUS.IDLE && !runtime.attention);
      currentSummary.classList.toggle("pmd-hidden", !active && !pending);
      editorNote.classList.toggle("pmd-hidden", !active && !pending);
      refreshEditor(snap);
      moduleList.querySelectorAll(".pmd-module-row").forEach((row, index) => {
        const isCurrent = modules[index]?.id === selectedId;
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
        refreshButton.setText("已刷新");
      } catch (error) {
        refreshButton.setText("刷新失败");
        logViewError(this.plugin, "daily-refresh", error);
      } finally {
        refreshButton.disabled = false;
        window.setTimeout(() => { if (refreshButton.isConnected) refreshButton.setText("刷新"); }, 1200);
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
