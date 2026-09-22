const { ItemView, Notice } = require("obsidian");
const { TIMER_STATUS, TIMER_STAGE } = require("../core/timer");
const { formatTomatoNumber, normalizeTag } = require("../core/validation");
const { workspaceLayoutLabel } = require("../integrations/workspaces-plus");
/** @typedef {import("../../types/contracts").Runtime} Runtime */
/** @typedef {import("../../types/contracts").Settings} Settings */
/** @typedef {{label:string, path:string}} ProjectOption */

/** @param {number} sec */
function mmss(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}
/** @param {any} plugin @param {string} operation @param {unknown} error @param {string} step */
function logViewError(plugin, operation, error, step) {
  console.error("Pomodoro AIO 视图操作失败", {
    operation,
    sessionId: plugin?.runtime?.sessionId || null,
    stage: plugin?.runtime?.stage || null,
    target: null,
    step,
    error: String(error instanceof Error ? error.message : error || "unknown error")
  });
}

/* ========== 视图（UI） ========== */
class PomodoroView extends ItemView {
  static VIEW_TYPE = "pomodoro-aio-view";
  /** @param {any} leaf @param {any} plugin */
  constructor(leaf, plugin){
    super(leaf);
    this.plugin=plugin;
    /** @type {Array<(() => void) | {off:()=>void}>} */
    this.disposers=[];
    /** @type {ProjectOption[]} */
    this._projOpts=[];
    this._todaySumCache=0;
  }
  getViewType(){ return PomodoroView.VIEW_TYPE; }
  getDisplayText(){ return "番茄钟"; }
  getIcon(){ return "clock"; }

  async onOpen(){
    try {
      this.plugin.setViewWasOpen(true);
    } catch (error) { logViewError(this.plugin, "view-lifecycle", error, "onOpen-saveState"); }

    try {
      const container = this.containerEl;
      container.empty(); container.addClass("pmd-root");

      // 顶部：环形 + 时间 + 状态
      const head = container.createDiv({ cls:"pmd-head" });
      const ring = head.createDiv({ cls:"pmd-ring" });
      ring.innerHTML = `<svg class="pmd-ring-svg" width="72" height="72" viewBox="0 0 72 72">
        <g transform="rotate(-90 36 36)">
          <circle cx="36" cy="36" r="30" class="pmd-ring-track"></circle>
          <circle cx="36" cy="36" r="30" class="pmd-ring-prog" stroke-dasharray="${2*Math.PI*30}" stroke-dashoffset="${2*Math.PI*30}"></circle>
        </g>
      </svg>
      <div class="pmd-ring-text">0/8</div>`;
      const ringText = /** @type {HTMLElement} */ (ring.querySelector(".pmd-ring-text"));
      const ringProgress = /** @type {SVGElement} */ (ring.querySelector(".pmd-ring-prog"));
      ring.setAttribute("role", "progressbar");
      ring.setAttribute("aria-label", "今日番茄进度");
      ring.setAttribute("aria-valuemin", "0");
      const timeEl  = head.createDiv({ cls:"pmd-time", text:mmss(this.plugin.getLeftSec()), attr:{ role:"timer", "aria-label":"剩余时间" } });
      const stateEl = head.createDiv({ cls:"pmd-state", text:"待机" });

      const modeButton = head.createEl("button", {
        text:"普通专注",
        cls:"pmd-btn pmd-mode-toggle",
        attr:{ type:"button", "aria-label":"切换工作模式", "aria-pressed":"false" }
      });

      // 顶部右侧：打开当日日记（放到右上角）
      const openTodayBtn = head.createEl("button", { text:"打开当日日记", cls:"pmd-btn pmd-btn-secondary", attr:{ type:"button" } });

      // —— 项目输入：普通模式直显，循环模式按需展开 ——
      const projectDetails = container.createEl("details", { cls:"pmd-project" });
      const projectSummary = projectDetails.createEl("summary", { text:"共同项目（可选）" });
      const projWrap = projectDetails.createDiv({ cls:"pmd-row-inline pmd-project-row" });
      const projBox  = projWrap.createDiv({ cls:"pmd-input-wrap" });
      const projectTagLabel = normalizeTag(this.plugin.settings.projectTag || "#project") || "#project";
      const projInput = projBox.createEl("input", { type:"text", attr:{ list:"pmdProjList", placeholder:`关联项目（可选；${projectTagLabel} 且状态在白名单）`, "aria-label":"关联项目（可选）" }, cls:"pmd-input" });
      const projList  = projBox.createEl("datalist", { attr:{ id:"pmdProjList" } });
      // 让输入框获得焦点时直接展开 datalist
      /** @param {HTMLInputElement} input */
      const _openDatalist = (input)=>{
        const prev = input.value;
        const inputWrap = !prev ? input.closest(".pmd-input-wrap") : null;
        inputWrap?.classList.add("pmd-datalist-opening");
        input.value = prev + "\u200B"; // 零宽空格触发 suggestions
        input.dispatchEvent(new Event('input', {bubbles:true}));
        setTimeout(()=>{
          input.value = prev;
          input.dispatchEvent(new Event('input', {bubbles:true}));
          inputWrap?.classList.remove("pmd-datalist-opening");
        }, 0);
      };
      projInput.addEventListener('focus', ()=> _openDatalist(projInput));
      projInput.addEventListener('click', ()=> _openDatalist(projInput));
      // 内嵌清空（×）
      const clearProjBtn = projBox.createEl("button", { text:"×", cls:"pmd-clear", attr:{ title:"清空项目选择", 'aria-label':"清空项目选择", type:"button" } });
      // Esc 清空
      projInput.onkeydown = (e)=>{
        if (this.plugin.shouldBlockHotkeys(e, { allowInPluginInput:true })) return;
        if (e.key === "Escape") { e.preventDefault(); projInput.value = ""; this.plugin.setCurrentProjectPath(""); }
      };
      const openProjBtn = projWrap.createEl("button", { text:"打开项目", cls:"pmd-btn pmd-btn-secondary", attr:{ type:"button" } });
      openProjBtn.onclick = ()=> this.plugin.openCurrentProject();

      // —— 任务输入（在项目下方）——
      const taskWrap = container.createDiv({ cls:"pmd-row pmd-row-inline" });
      const taskBox  = taskWrap.createDiv({ cls:"pmd-input-wrap" });
      const taskInput = taskBox.createEl("input", { type:"text", attr:{ list:"pmdTaskList", placeholder:"输入/选择任务名（仅显示未勾选）", "aria-label":"当前任务" }, cls:"pmd-input" });
      taskInput.addEventListener('focus', ()=> _openDatalist(taskInput));
      taskInput.addEventListener('click', ()=> _openDatalist(taskInput));
      const taskList  = taskBox.createEl("datalist", { attr:{ id:"pmdTaskList" } });
      // 抑制回填：使用“截至时间戳”，避免广播抖动导致的闪动
      let _suppressTaskSyncUntil = 0;
      // 内嵌清空（×）
      const clearTaskBtn = taskBox.createEl("button", { text:"×", cls:"pmd-clear", attr:{ title:"清空任务名", 'aria-label':"清空任务名", type:"button" } });
      const taskBlackoutBtn = taskWrap.createEl("button", {
        text:"执行时黑屏", cls:"pmd-task-blackout-toggle",
        attr:{ type:"button", "aria-label":"当前任务执行时黑屏", "aria-pressed":"false", title:"此任务执行时显示黑屏" }
      });
      // Esc 清空
      taskInput.onkeydown = (e)=>{
        if (this.plugin.shouldBlockHotkeys(e, { allowInPluginInput:true })) return;
        if (e.key === "Escape") { e.preventDefault(); _suppressTaskSyncUntil = Date.now() + 1200; taskInput.value = ""; this.plugin.setCurrentTaskName(""); }
      };

      // —— 长专注控制 ——
      const longWrap = container.createDiv({ cls:"pmd-row pmd-row-inline pmd-long-row" });
      longWrap.createSpan({ cls:"pmd-long-label", text:"长专注（分钟）" });
      const longInput = longWrap.createEl("input", {
        type:"number",
        cls:"pmd-long-input",
        attr:{ min:"1", step:"5", placeholder:"50", "aria-label":"长专注时长（分钟）" }
      });
      const ensureLongValue = ()=>{
        const fallback = this.plugin.runtime.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25;
        const val = Number(longInput.value);
        const normalized = isFinite(val) && val > 0 ? Math.round(val * 10) / 10 : Math.round(fallback * 10) / 10;
        longInput.value = String(normalized);
        this.plugin.setLongFocusMinutes(normalized);
        return normalized;
      };
      longInput.value = String(this.plugin.runtime.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25);
      longInput.onchange = ()=> ensureLongValue();
      longInput.onblur = ()=> ensureLongValue();
      const longBtn = longWrap.createEl("button", { text:"开始长专注", cls:"pmd-btn", attr:{ type:"button" } });

      const cycleWrap = container.createDiv({ cls:"pmd-cycle" });
      const cycleRowA = cycleWrap.createDiv({ cls:"pmd-cycle-row" });
      const cycleRoleA = cycleRowA.createSpan({ cls:"pmd-cycle-role", text:"当前" });
      const cycleFieldsA = cycleRowA.createDiv({ cls:"pmd-cycle-fields" });
      const cycleTaskWrapA = cycleFieldsA.createDiv({ cls:"pmd-input-wrap pmd-cycle-task-input" });
      const cycleTaskA = cycleTaskWrapA.createEl("input", {
        type:"text", cls:"pmd-input",
        attr:{ list:"pmdCycleTaskListA", placeholder:"任务 A", "aria-label":"循环任务 A" }
      });
      const cycleTaskListA = cycleTaskWrapA.createEl("datalist", { attr:{ id:"pmdCycleTaskListA" } });
      const clearCycleTaskA = cycleTaskWrapA.createEl("button", { text:"×", cls:"pmd-clear", attr:{ title:"清空任务名", "aria-label":"清空任务名", type:"button" } });
      const cycleTaskBlackoutA = cycleFieldsA.createEl("button", {
        text:"执行时黑屏", cls:"pmd-task-blackout-toggle",
        attr:{ type:"button", "aria-label":"任务 A 执行时黑屏", "aria-pressed":"false", title:"任务 A 执行时显示黑屏" }
      });
      const completeCycleTaskA = cycleTaskWrapA.createEl("button", { text:"完成", cls:"pmd-clear pmd-complete-cycle", attr:{ title:"完成任务 A", "aria-label":"完成任务 A", type:"button" } });
      const cycleWorkspaceWrapA = cycleFieldsA.createDiv({ cls:"pmd-input-wrap" });
      const cycleWorkspaceA = cycleWorkspaceWrapA.createEl("input", {
        type:"text",
        cls:"pmd-cycle-workspace",
        attr:{ list:"pmdCycleWorkspaceListA", placeholder:"筛选/选择布局", "aria-label":"任务 A 工作区布局", title:"开始任务 A 时加载的 Workspaces Plus 布局" }
      });
      const cycleWorkspaceListA = cycleWorkspaceWrapA.createEl("datalist", { attr:{ id:"pmdCycleWorkspaceListA" } });
      const clearCycleWorkspaceA = cycleWorkspaceWrapA.createEl("button", { text:"×", cls:"pmd-clear", attr:{ title:"清空工作区选择", "aria-label":"清空工作区选择", type:"button" } });
      const cycleDurationA = cycleRowA.createDiv({ cls:"pmd-cycle-duration" });
      const cycleMinA = cycleDurationA.createEl("input", {
        type:"number", cls:"pmd-cycle-min",
        attr:{ min:"1", step:"1", placeholder:"时长", "aria-label":"任务 A 时长（分钟）" }
      });
      cycleDurationA.createSpan({ cls:"pmd-cycle-unit", text:"分钟" });

      const cycleRowB = cycleWrap.createDiv({ cls:"pmd-cycle-row" });
      const cycleRoleB = cycleRowB.createSpan({ cls:"pmd-cycle-role", text:"下一段" });
      const cycleFieldsB = cycleRowB.createDiv({ cls:"pmd-cycle-fields" });
      const cycleTaskWrapB = cycleFieldsB.createDiv({ cls:"pmd-input-wrap pmd-cycle-task-input" });
      const cycleTaskB = cycleTaskWrapB.createEl("input", {
        type:"text", cls:"pmd-input",
        attr:{ list:"pmdCycleTaskListB", placeholder:"任务 B", "aria-label":"循环任务 B" }
      });
      const cycleTaskListB = cycleTaskWrapB.createEl("datalist", { attr:{ id:"pmdCycleTaskListB" } });
      const clearCycleTaskB = cycleTaskWrapB.createEl("button", { text:"×", cls:"pmd-clear", attr:{ title:"清空任务名", "aria-label":"清空任务名", type:"button" } });
      const cycleTaskBlackoutB = cycleFieldsB.createEl("button", {
        text:"执行时黑屏", cls:"pmd-task-blackout-toggle",
        attr:{ type:"button", "aria-label":"任务 B 执行时黑屏", "aria-pressed":"false", title:"任务 B 执行时显示黑屏" }
      });
      const completeCycleTaskB = cycleTaskWrapB.createEl("button", { text:"完成", cls:"pmd-clear pmd-complete-cycle", attr:{ title:"完成任务 B", "aria-label":"完成任务 B", type:"button" } });
      const cycleWorkspaceWrapB = cycleFieldsB.createDiv({ cls:"pmd-input-wrap" });
      const cycleWorkspaceB = cycleWorkspaceWrapB.createEl("input", {
        type:"text",
        cls:"pmd-cycle-workspace",
        attr:{ list:"pmdCycleWorkspaceListB", placeholder:"筛选/选择布局", "aria-label":"任务 B 工作区布局", title:"开始任务 B 时加载的 Workspaces Plus 布局" }
      });
      const cycleWorkspaceListB = cycleWorkspaceWrapB.createEl("datalist", { attr:{ id:"pmdCycleWorkspaceListB" } });
      const clearCycleWorkspaceB = cycleWorkspaceWrapB.createEl("button", { text:"×", cls:"pmd-clear", attr:{ title:"清空工作区选择", "aria-label":"清空工作区选择", type:"button" } });
      const cycleDurationB = cycleRowB.createDiv({ cls:"pmd-cycle-duration" });
      const cycleMinB = cycleDurationB.createEl("input", {
        type:"number", cls:"pmd-cycle-min",
        attr:{ min:"1", step:"1", placeholder:"时长", "aria-label":"任务 B 时长（分钟）" }
      });
      cycleDurationB.createSpan({ cls:"pmd-cycle-unit", text:"分钟" });
      cycleTaskA.value = this.plugin.settings.cycleTaskA || "";
      cycleTaskB.value = this.plugin.settings.cycleTaskB || "";
      cycleMinA.value = String(this.plugin.settings.cycleMinA || 15);
      cycleMinB.value = String(this.plugin.settings.cycleMinB || 15);
      /** @param {HTMLInputElement} input @param {ObsidianElement} list @param {string} [selected] */
      const fillWorkspaceList = (input, list, selected="")=> {
        const commands = this.plugin.getWorkspaceLayoutCommands();
        list.empty();
        commands.forEach((/** @type {Record<string, any>} */ command)=> list.createEl("option", { attr:{ value:workspaceLayoutLabel(command) } }));
        const selectedCommand = commands.find((/** @type {Record<string, any>} */ command)=> command.id === selected);
        input.dataset.commandId = selectedCommand?.id || "";
        input.value = selectedCommand ? workspaceLayoutLabel(selectedCommand) : selected ? "布局已失效，请重选" : "";
      };
      /** @param {HTMLInputElement} input */
      const selectWorkspace = input=> {
        const command = this.plugin.getWorkspaceLayoutCommands().find((/** @type {Record<string, any>} */ item)=> workspaceLayoutLabel(item) === input.value.trim());
        if (!command && input.value.trim()) {
          const current = this.plugin.getWorkspaceLayoutCommands().find((/** @type {Record<string, any>} */ item)=> item.id === input.dataset.commandId);
          input.value = current ? workspaceLayoutLabel(current) : "";
          return;
        }
        input.dataset.commandId = command?.id || "";
        saveCycleConfig();
      };
      fillWorkspaceList(cycleWorkspaceA, cycleWorkspaceListA, this.plugin.settings.cycleWorkspaceCommandA || "");
      fillWorkspaceList(cycleWorkspaceB, cycleWorkspaceListB, this.plugin.settings.cycleWorkspaceCommandB || "");
      cycleWorkspaceA.onfocus = ()=> fillWorkspaceList(cycleWorkspaceA, cycleWorkspaceListA, cycleWorkspaceA.dataset.commandId || "");
      cycleWorkspaceB.onfocus = ()=> fillWorkspaceList(cycleWorkspaceB, cycleWorkspaceListB, cycleWorkspaceB.dataset.commandId || "");

      // 操作按钮
      const actions = container.createDiv({ cls:"pmd-actions" });
      const startBtn = actions.createEl("button", { text:"开始专注", cls:"pmd-btn pmd-btn-primary", attr:{ type:"button" } });
      const pauseBtn = actions.createEl("button", { text:"暂停", cls:"pmd-btn", attr:{ type:"button" } });
      const resetBtn = actions.createEl("button", { text:"重置", cls:"pmd-btn", attr:{ type:"button" } });
      const doneBtn  = actions.createEl("button", { text:"完成本段", cls:"pmd-btn", attr:{ type:"button" } });
      const completeTaskBtn = actions.createEl("button", { text:"完成任务", cls:"pmd-btn", attr:{ type:"button" } });
      const refreshBtn = actions.createEl("button", { text:"刷新", cls:"pmd-btn pmd-btn-secondary", attr:{ type:"button" } });
      const quickCaptureBtn = actions.createEl("button", { text:"快速捕捉", cls:"pmd-btn pmd-btn-secondary", attr:{ type:"button", "aria-expanded":"false", "aria-controls":"pmd-quick-capture" } });
      const capturePanel = container.createDiv({ cls:"pmd-capture-panel pmd-hidden", attr:{ id:"pmd-quick-capture" } });
      const captureInput = capturePanel.createEl("input", {
        type:"text",
        cls:"pmd-input pmd-capture-input",
        attr:{ placeholder:"输入后按 Enter 保存为待办", "aria-label":"快速捕捉内容" }
      });
      const captureStatus = capturePanel.createDiv({ cls:"pmd-capture-status", attr:{ role:"status", "aria-live":"polite" } });
      let captureSubmitting = false;
      /** @type {number | null} */
      let captureAutoCloseTimer = null;
      const cancelCaptureAutoClose = ()=> {
        if (captureAutoCloseTimer === null) return;
        window.clearTimeout(captureAutoCloseTimer);
        captureAutoCloseTimer = null;
      };
      const closeCapturePanel = ()=> {
        cancelCaptureAutoClose();
        capturePanel.addClass("pmd-hidden");
        quickCaptureBtn.setAttribute("aria-expanded", "false");
        captureStatus.setText("");
      };
      const openCapturePanel = ()=> {
        cancelCaptureAutoClose();
        capturePanel.removeClass("pmd-hidden");
        quickCaptureBtn.setAttribute("aria-expanded", "true");
        window.setTimeout(()=> captureInput.focus(), 0);
      };
      const submitCapture = async ()=> {
        if (captureSubmitting) return;
        captureSubmitting = true;
        captureInput.disabled = true;
        captureStatus.setText("正在保存…");
        try {
          await this.plugin.quickCapture(captureInput.value, "todo");
          captureInput.value = "";
          captureStatus.setText("已保存");
          cancelCaptureAutoClose();
          captureAutoCloseTimer = window.setTimeout(()=> {
            captureAutoCloseTimer = null;
            closeCapturePanel();
          }, 700);
        } catch (error) {
          captureStatus.setText("保存失败，请检查设置");
          logViewError(this.plugin, "quick-capture", error, "write");
        } finally {
          captureSubmitting = false;
          captureInput.disabled = false;
          if (!capturePanel.classList.contains("pmd-hidden")) captureInput.focus();
        }
      };
      quickCaptureBtn.onclick = ()=> capturePanel.classList.contains("pmd-hidden") ? openCapturePanel() : closeCapturePanel();
      captureInput.oninput = cancelCaptureAutoClose;
      captureInput.onkeydown = event => {
        if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          submitCapture();
        } else if (event.key === "Escape") {
          event.preventDefault();
          captureInput.value = "";
          closeCapturePanel();
          quickCaptureBtn.focus();
        }
      };

      // 底部信息
      const meta = container.createDiv({ cls:"pmd-meta" });
      const sumEl = meta.createSpan({ text:"今日累计：0🍅" });
      const sessionEl = meta.createSpan({ text:"  本次已完成：0 段" });

      /* 事件绑定 */
      /** @type {number | null} */
      let taskSaveTimer = null;
      const saveTask = ()=>{
        if (taskSaveTimer) window.clearTimeout(taskSaveTimer);
        taskSaveTimer = null;
        if (this.plugin.runtime.currentTaskName === taskInput.value.trim()) return;
        this.plugin.setCurrentTaskName(taskInput.value);
      };
      taskInput.oninput = ()=> {
        _suppressTaskSyncUntil = Date.now() + 1200;
        if (taskSaveTimer) window.clearTimeout(taskSaveTimer);
        taskSaveTimer = window.setTimeout(saveTask, 180);
      };
      taskInput.onchange = saveTask;
      taskBlackoutBtn.onclick = ()=> this.plugin.setTaskBlackoutEnabled(this.plugin.settings.taskBlackoutEnabled !== true);
      modeButton.onclick = ()=> {
        const next = this.plugin.settings.workMode === 'cycle' ? 'standard' : 'cycle';
        this.plugin.setWorkMode(next);
      };
      /** @type {number | null} */
      let cycleSaveTimer = null;
      const saveCycleConfig = ()=> {
        if (cycleSaveTimer) window.clearTimeout(cycleSaveTimer);
        cycleSaveTimer = null;
        const patch = {
        cycleTaskA: cycleTaskA.value.trim(), cycleMinA: Math.max(1, Number(cycleMinA.value) || 15), cycleWorkspaceCommandA: cycleWorkspaceA.dataset.commandId || "",
        cycleTaskB: cycleTaskB.value.trim(), cycleMinB: Math.max(1, Number(cycleMinB.value) || 15), cycleWorkspaceCommandB: cycleWorkspaceB.dataset.commandId || ""
        };
        if (Object.entries(patch).every(([key, value])=> this.plugin.settings[key] === value)) return;
        this.plugin.setCycleConfig(patch);
      };
      const queueCycleSave = ()=>{
        if (cycleSaveTimer) window.clearTimeout(cycleSaveTimer);
        cycleSaveTimer = window.setTimeout(saveCycleConfig, 180);
      };
      [cycleTaskA, cycleMinA, cycleTaskB, cycleMinB].forEach(input=>{
        input.oninput = queueCycleSave;
        input.onchange = saveCycleConfig;
      });
      [cycleWorkspaceA, cycleWorkspaceB].forEach(input=> {
        input.oninput = ()=> {
          if (this.plugin.getWorkspaceLayoutCommands().some((/** @type {Record<string, any>} */ command)=> workspaceLayoutLabel(command) === input.value.trim())) selectWorkspace(input);
        };
        input.onchange = ()=> selectWorkspace(input);
      });
      [cycleTaskA, cycleTaskB].forEach(input=> {
        input.addEventListener('focus', ()=> _openDatalist(input));
        input.addEventListener('click', ()=> _openDatalist(input));
      });
      cycleTaskBlackoutA.onclick = ()=> this.plugin.setCycleConfig({ cycleTaskBlackoutA: this.plugin.settings.cycleTaskBlackoutA !== true });
      cycleTaskBlackoutB.onclick = ()=> this.plugin.setCycleConfig({ cycleTaskBlackoutB: this.plugin.settings.cycleTaskBlackoutB !== true });
      cycleRowA.ondblclick = (event)=> { if (!(event.target instanceof Element && event.target.closest("input, button, select"))) this.plugin.selectCycleSlot(0); };
      cycleRowB.ondblclick = (event)=> { if (!(event.target instanceof Element && event.target.closest("input, button, select"))) this.plugin.selectCycleSlot(1); };
      /** @param {Event | null | undefined} event */
      const clearCurrentTask = (event)=> {
        event?.preventDefault();
        if (taskSaveTimer) window.clearTimeout(taskSaveTimer);
        taskSaveTimer = null;
        _suppressTaskSyncUntil = Date.now() + 1500;
        taskInput.value = "";
        this.plugin.setCurrentTaskName("");
        taskInput.focus();
      };
      /** @param {HTMLInputElement} input @param {Event | null | undefined} event */
      const clearCycleTask = (input, event)=> {
        event?.preventDefault();
        input.value = "";
        saveCycleConfig();
        input.focus();
      };
      /** @param {HTMLInputElement} input @param {Event | null | undefined} event */
      const clearCycleWorkspace = (input, event)=> {
        event?.preventDefault();
        input.value = "";
        input.dataset.commandId = "";
        saveCycleConfig();
        input.focus();
      };
      clearTaskBtn.onpointerdown = clearCurrentTask;
      clearTaskBtn.onclick = (event)=> { if (event.detail === 0) clearCurrentTask(event); };
      clearCycleTaskA.onpointerdown = (event)=> clearCycleTask(cycleTaskA, event);
      clearCycleTaskA.onclick = (event)=> { if (event.detail === 0) clearCycleTask(cycleTaskA, event); };
      clearCycleTaskB.onpointerdown = (event)=> clearCycleTask(cycleTaskB, event);
      clearCycleTaskB.onclick = (event)=> { if (event.detail === 0) clearCycleTask(cycleTaskB, event); };
      completeCycleTaskA.onclick = event=> this.plugin.runUserCommand(() => this.plugin.completeTask({ cycleSlot:0 }), event);
      completeCycleTaskB.onclick = event=> this.plugin.runUserCommand(() => this.plugin.completeTask({ cycleSlot:1 }), event);
      clearCycleWorkspaceA.onpointerdown = (event)=> clearCycleWorkspace(cycleWorkspaceA, event);
      clearCycleWorkspaceA.onclick = (event)=> { if (event.detail === 0) clearCycleWorkspace(cycleWorkspaceA, event); };
      clearCycleWorkspaceB.onpointerdown = (event)=> clearCycleWorkspace(cycleWorkspaceB, event);
      clearCycleWorkspaceB.onclick = (event)=> { if (event.detail === 0) clearCycleWorkspace(cycleWorkspaceB, event); };
      projInput.onchange = ()=>{
        const label = projInput.value;
        const hit = (this._projOpts||[]).find(x=> x.label===label);
        this.plugin.setCurrentProjectPath(hit? hit.path : "");
      };
      /** @param {Event | null | undefined} event */
      const clearProject = (event)=> {
        event?.preventDefault();
        projInput.value = "";
        this.plugin.setCurrentProjectPath("");
        projInput.focus();
      };
      clearProjBtn.onpointerdown = clearProject;
      clearProjBtn.onclick = (event)=> { if (event.detail === 0) clearProject(event); };
      openTodayBtn.onclick = event=> this.plugin.runUserCommand(() => this.plugin.openToday(), event);
      longBtn.onclick = event=> this.plugin.runUserCommand(() => {
        const minutes = ensureLongValue();
        this.plugin.requestTaskBlackoutFullscreen();
        return this.plugin.startFocus({ cause:'manual', minutes });
      }, event);

      startBtn.onclick = event=> this.plugin.runUserCommand(() => {
        const snap = this.plugin.snapshot();
        if (snap.runtime.status === TIMER_STATUS.PAUSED) return this.plugin.togglePause(true);
        if (snap.runtime.attention && !snap.runtime.attention.nextStarted) {
          if (snap.runtime.attention.type === TIMER_STAGE.BREAK) this.plugin.requestBreakBlackoutFullscreen();
          return this.plugin.startPendingStage();
        }
        if (this.plugin.settings.workMode === 'cycle') {
          saveCycleConfig();
          this.plugin.requestTaskBlackoutFullscreen({ cycle:true, cycleSlot:snap.runtime.cycleSlot });
          return this.plugin.startCycle();
        } else {
          saveTask();
          this.plugin.requestTaskBlackoutFullscreen();
          return this.plugin.startFocus({ cause:'manual' });
        }
      }, event);
      pauseBtn.onclick = event=> this.plugin.runUserCommand(() => this.plugin.togglePause(), event);
      resetBtn.onclick = event=> this.plugin.runUserCommand(() => this.plugin.reset(), event);
      doneBtn.onclick  = event=> this.plugin.runUserCommand(() => this.plugin.forceCompleteFocusOnce(), event);
      completeTaskBtn.onclick = event=> this.plugin.runUserCommand(() => this.plugin.completeTask(), event);
      const refreshTodayUI = async ()=>{
        const snap = await this._safeRefreshTodaySnapshot();
        this._todaySumCache = snap.sum;
        this._fillTaskOptions(taskList, snap.unchecked);
        this._fillTaskOptions(cycleTaskListA, snap.unchecked);
        this._fillTaskOptions(cycleTaskListB, snap.unchecked);
        sumEl.setText(`今日累计：${formatTomatoNumber(snap.sum)}🍅`);
        this.plugin.broadcast();
      };
      refreshBtn.onclick = refreshTodayUI;

      // 订阅状态广播
      let lastRenderKey = "";
      /** @type {boolean | null} */
      let lastProjectMode = null;
      /** @param {HTMLElement} el @param {boolean} visible */
      const show = (el, visible)=> el.classList.toggle("pmd-hidden", !visible);
      /** @param {{settings:Settings, runtime:Runtime & {leftSec?:number}}} snap */
      const onState = (snap)=> {
        const { settings:s, runtime:r } = snap;
        const cycleMode = s.workMode === 'cycle';
        timeEl.setText(mmss(r.leftSec||0));

        const renderKey = [
          cycleMode, s.showProjectSelector, s.currentProjectPath, s.dailyGoal,
          s.taskBlackoutEnabled,
          s.cycleTaskA, s.cycleMinA, s.cycleWorkspaceCommandA,
          s.cycleTaskBlackoutA,
          s.cycleTaskB, s.cycleMinB, s.cycleWorkspaceCommandB,
          s.cycleTaskBlackoutB,
          r.status, r.stage, JSON.stringify(r.attention), r.mode, r.cycleSlot,
          r.sessionCount, r.currentTaskName,
          r.longFocusMinutes, this._todaySumCache
        ].join("|");
        if (renderKey === lastRenderKey) return;
        lastRenderKey = renderKey;

        projectDetails.classList.toggle('pmd-hidden', s.showProjectSelector === false);
        projectDetails.classList.toggle('is-cycle', cycleMode);
        if (lastProjectMode !== cycleMode) {
          projectDetails.open = !cycleMode;
          lastProjectMode = cycleMode;
        }
        const projectName = String(s.currentProjectPath||"").split("/").pop()?.replace(/\.md$/i, "");
        projectSummary.setText(projectName ? `共同项目 · ${projectName}` : "共同项目（可选）");
        projInput.setAttribute("placeholder", cycleMode ? "选择共同项目（可选）" : `关联项目（可选；${projectTagLabel} 且状态在白名单）`);
        projInput.setAttribute("aria-label", cycleMode ? "共同项目（可选）" : "关联项目（可选）");
        taskWrap.classList.toggle('pmd-hidden', cycleMode);
        longWrap.classList.toggle('pmd-hidden', cycleMode);
        cycleWrap.classList.toggle('pmd-hidden', !cycleMode);
        /** @param {HTMLElement} button @param {boolean} enabled */
        const setBlackoutPressed = (button, enabled)=> {
          button.setAttribute("aria-pressed", String(enabled));
          button.setAttribute("title", enabled ? "执行时会显示黑屏；点击关闭" : "执行时不显示黑屏；点击开启");
        };
        setBlackoutPressed(taskBlackoutBtn, s.taskBlackoutEnabled === true);
        setBlackoutPressed(cycleTaskBlackoutA, s.cycleTaskBlackoutA === true);
        setBlackoutPressed(cycleTaskBlackoutB, s.cycleTaskBlackoutB === true);
        const modeLocked = r.status !== TIMER_STATUS.IDLE || !!r.attention;
        modeButton.disabled = modeLocked;
        modeButton.setText(cycleMode ? "循环工作" : "普通专注");
        modeButton.setAttribute("aria-pressed", String(cycleMode));
        modeButton.setAttribute("aria-label", cycleMode ? "当前为循环工作，点击切换到普通专注" : "当前为普通专注，点击切换到循环工作");
        modeButton.setAttribute("title", cycleMode ? "切换到普通专注" : "切换到循环工作");
        const cycleRunning = r.mode === "cycle" && /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED]).includes(r.status);
        const lockCycleA = cycleRunning && r.cycleSlot === 0;
        const lockCycleB = cycleRunning && r.cycleSlot === 1;
        [cycleTaskA, cycleMinA, clearCycleTaskA, cycleWorkspaceA, clearCycleWorkspaceA].forEach(input=> input.disabled = lockCycleA);
        [cycleTaskB, cycleMinB, clearCycleTaskB, cycleWorkspaceB, clearCycleWorkspaceB].forEach(input=> input.disabled = lockCycleB);
        completeCycleTaskA.disabled = !String(s.cycleTaskA || "").trim();
        completeCycleTaskB.disabled = !String(s.cycleTaskB || "").trim();
        if (document.activeElement !== cycleWorkspaceA && cycleWorkspaceA.dataset.commandId !== (s.cycleWorkspaceCommandA || "")) {
          fillWorkspaceList(cycleWorkspaceA, cycleWorkspaceListA, s.cycleWorkspaceCommandA || "");
        }
        if (document.activeElement !== cycleWorkspaceB && cycleWorkspaceB.dataset.commandId !== (s.cycleWorkspaceCommandB || "")) {
          fillWorkspaceList(cycleWorkspaceB, cycleWorkspaceListB, s.cycleWorkspaceCommandB || "");
        }
        if (cycleMode) {
          const currentSlot = r.attention && Number.isInteger(r.attention.cycleSlot) ? r.attention.cycleSlot : (r.cycleSlot === 1 ? 1 : 0);
          const canSelectSlot = r.status === TIMER_STATUS.IDLE && !r.attention;
          const attentionActive = !!r.attention;
          cycleRowA.classList.toggle("is-current", currentSlot === 0);
          cycleRowB.classList.toggle("is-current", currentSlot === 1);
          cycleRowA.classList.toggle("is-selectable", canSelectSlot);
          cycleRowB.classList.toggle("is-selectable", canSelectSlot);
          cycleRowA.setAttribute("title", canSelectSlot ? "双击设为当前任务" : "");
          cycleRowB.setAttribute("title", canSelectSlot ? "双击设为当前任务" : "");
          cycleRoleA.setText(currentSlot === 0 ? (attentionActive ? "待开始" : "当前") : "下一段");
          cycleRoleB.setText(currentSlot === 1 ? (attentionActive ? "待开始" : "当前") : "下一段");
          cycleRowA.setAttribute("aria-label", `${cycleRoleA.textContent}：任务 A`);
          cycleRowB.setAttribute("aria-label", `${cycleRoleB.textContent}：任务 B`);
        }

        // 环形进度
        const max = s.dailyGoal||8; const done = this._todaySumCache ?? 0;
        ringText.textContent = `${formatTomatoNumber(done)}/${max}`;
        ring.setAttribute("aria-valuemax", String(max));
        ring.setAttribute("aria-valuenow", String(done));
        const C = 2*Math.PI*30; const offset = C * (1 - Math.min(done/max,1));
        ringProgress.setAttribute("stroke-dashoffset", String(offset));

        // 状态与可用操作
        const stateLabel = r.status === TIMER_STATUS.AWAITING ? "待确认"
          : r.status === TIMER_STATUS.FAILED ? "待恢复"
          : r.status === TIMER_STATUS.SETTLING ? "结算中"
          : r.status === TIMER_STATUS.RUNNING || r.status === TIMER_STATUS.PAUSED
            ? (r.stage === TIMER_STAGE.FOCUS ? "专注" : "休息") : "待机";
        stateEl.setText(stateLabel);
        const idle = r.status === TIMER_STATUS.IDLE || r.status === TIMER_STATUS.AWAITING;
        const active = r.status === TIMER_STATUS.RUNNING || r.status === TIMER_STATUS.PAUSED;
        show(startBtn, idle || r.status === TIMER_STATUS.PAUSED);
        show(pauseBtn, r.status === TIMER_STATUS.RUNNING);
        show(resetBtn, r.status !== TIMER_STATUS.IDLE || !!r.attention);
        show(doneBtn, r.stage === TIMER_STAGE.FOCUS && active);
        show(completeTaskBtn, !cycleMode && !!String(r.currentTaskName || s.defaultTaskName || "").trim());

        if (r.status === TIMER_STATUS.PAUSED) startBtn.setText("继续");
        else if (r.attention?.type === TIMER_STAGE.BREAK) startBtn.setText("开始休息");
        else if (r.attention?.type === TIMER_STAGE.FOCUS) startBtn.setText(cycleMode ? "开始下一段" : "开始专注");
        else startBtn.setText(cycleMode ? "开始循环工作" : "开始专注");

        // 任务名与会话数
        if (Date.now() >= _suppressTaskSyncUntil && document.activeElement !== taskInput && taskInput.value !== (r.currentTaskName||"")) taskInput.value = r.currentTaskName||"";
        sessionEl.setText(`本次已完成：${r.sessionCount||0} 段`);
        if (document.activeElement !== longInput) {
          const target = r.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25;
          longInput.value = String(Math.round(target * 10) / 10);
        }
      };
      this.app.workspace.on('pomodoro:aio-state', onState);
      this.disposers.push(()=> this.app.workspace.off('pomodoro:aio-state', onState));

      // 先渲染可操作界面，再读取日记和项目数据。
      taskInput.value = this.plugin.runtime.currentTaskName || this.plugin.settings.defaultTaskName || "";
      longInput.value = String(Math.round((this.plugin.runtime.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25) * 10) / 10);
      onState(this.plugin.snapshot());
      await refreshTodayUI();

      const projects = this._safeProjectCandidates();
      this._projOpts = projects;
      this._fillProjectOptions(projList, projects);
      if (this.plugin.settings.currentProjectPath){
        const hit = projects.find(p=> p.path === this.plugin.settings.currentProjectPath);
        if (hit) projInput.value = hit.label;
      }

      // 只在当日日记变化时刷新，避免固定轮询整个文件。
      /** @type {number | null} */
      let vaultRefreshTimer = null;
      /** @param {{path?:string} | null | undefined} file */
      const onVaultModify = file=>{
        if (file?.path !== this.plugin.todayFilePath()) return;
        if (vaultRefreshTimer) window.clearTimeout(vaultRefreshTimer);
        vaultRefreshTimer = window.setTimeout(refreshTodayUI, 180);
      };
      const vaultModifyRef = this.app.vault.on("modify", onVaultModify);
      this.disposers.push(()=>{
        if (vaultRefreshTimer) window.clearTimeout(vaultRefreshTimer);
        this.app.vault.offref(vaultModifyRef);
      });
      this.disposers.push(()=>{
        if (taskSaveTimer) saveTask();
        if (cycleSaveTimer) saveCycleConfig();
        cancelCaptureAutoClose();
      });
    } catch(err){
      logViewError(this.plugin, "view-render", err, "onOpen");
      new Notice("番茄视图加载失败，请检查日志");
    }
  }

  /** @param {ObsidianElement} datalist @param {string[]} arr */
  _fillTaskOptions(datalist, arr){
    datalist.empty(); arr.forEach(n=> datalist.createEl("option", { attr:{ value:n } }));
  }
  /** @param {ObsidianElement} datalist @param {ProjectOption[]} arr */
  _fillProjectOptions(datalist, arr){
    datalist.empty(); arr.forEach(o=> datalist.createEl("option", { attr:{ value:o.label } }));
  }

  async _safeRefreshTodaySnapshot(){
    try { return await this.plugin.refreshTodaySnapshot(); }
    catch(err){ logViewError(this.plugin, "daily-refresh", err, "read"); return { file:null, sum:0, unchecked:[] }; }
  }
  /** @returns {ProjectOption[]} */
  _safeProjectCandidates(){
    try { return this.plugin.projectCandidates(); }
    catch(err){ logViewError(this.plugin, "project-refresh", err, "list"); return []; }
  }

  async onClose(){
    this.disposers.forEach(off=>{
      try {
        if (typeof off === 'function') off();
        else if (off?.off) off.off();
      } catch(err){ logViewError(this.plugin, "view-lifecycle", err, "dispose"); }
    });
    this.disposers.length=0;
    try {
      this.plugin.setViewWasOpen(false);
    } catch (error) { logViewError(this.plugin, "view-lifecycle", error, "onClose-saveState"); }
  }
}

module.exports = { PomodoroView };
