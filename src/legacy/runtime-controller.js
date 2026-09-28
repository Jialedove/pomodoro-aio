const { configuredStageDurationMs } = require("./timer");
const { Notice } = require("obsidian");
const { TIMER_STATUS, TIMER_STAGE, createSessionId } = require("../core/timer");
const { RUNTIME_EVENT } = require("./state-machine");
const { formatTomatoNumber } = require("../core/validation");
const { planTaskLineCompletion } = require("../core/task-lines");
const { buildNextStageTransition } = require("./settlement-recovery");
const { normalizeBreakContinuation, normalizeModuleRun } = require("./runtime-normalization");
/** @typedef {import("../../types/legacy-contracts").BreakContinuation} BreakContinuation */
/** @typedef {import("../../types/contracts").Settings} Settings */
/** @typedef {import("../../types/legacy-contracts").LegacyAttention} Attention */
/** @typedef {import("../../types/legacy-contracts").LegacyBreakTransition} BreakTransition */
/** @typedef {import("../../types/contracts").TimerStage} TimerStage */
/** @typedef {{type?:string,isLong?:boolean,cycleSlot?:number|null,autoStarted?:boolean,durationMs?:number,taskName?:string,moduleIndex?:number,moduleRun?:import("../../types/contracts").ModuleRun|null}} NextPhase */
/** @typedef {{suppressNotify?:boolean, cause?:string, minutes?:number|null, cycle?:boolean, cycleSlot?:0|1, taskName?:string, durationMs?:number, allowTransition?:boolean, allowPendingSettlement?:boolean, allowPendingBreakTransition?:boolean, newCycle?:boolean}} StartFocusOptions */
/** @typedef {{forceRun?:boolean, suppressNotify?:boolean, cause?:string, durationMs?:number, allowTransition?:boolean, allowPendingSettlement?:boolean, allowPendingBreakTransition?:boolean, breakContinuation?:BreakContinuation}} StartBreakOptions */

class LegacyRuntimeController {
  /** @param {any} plugin @param {{playBeep:Function,sysNotify:Function,logPluginError:Function,normalizeSettings:Function,tryNormalizeMarkdownPath:Function}} helpers */
  constructor(plugin, helpers){ this.plugin = plugin; this.helpers = helpers; }
  /** @param {any} runtime @param {number} sessionCountAfter */
  buildNextStageTransition(runtime, sessionCountAfter){
    return buildNextStageTransition(this.plugin.settings, runtime, sessionCountAfter);
  }
  async startPendingStage(){
    const next = this.plugin.runtime.attention;
    if (!next || next.nextStarted) { await this.plugin.stopStrongAlert(); return; }
    if (next.type === TIMER_STAGE.BREAK) return this.plugin.startBreak(next.isLong, {
      forceRun:true, cause:"manual", durationMs:next.durationMs, allowTransition:true,
      breakContinuation:this.plugin.runtime.breakContinuation || undefined
    });
    if (next.type === TIMER_STAGE.FOCUS && Number.isInteger(next.cycleSlot)) {
      /** @type {StartFocusOptions} */
      const options = { cause:"manual", durationMs:next.durationMs, allowTransition:true };
      if (next.taskName !== undefined) options.taskName = next.taskName;
      return this.plugin.startCycle(next.cycleSlot === 1 ? 1 : 0, options);
    }
    if (next.type === TIMER_STAGE.FOCUS) return this.plugin.startFocus({
      cause:"manual", durationMs:next.durationMs, allowTransition:true
    });
    return this.plugin.stopStrongAlert();
  }
  /** @param {any} runtime */
  resumeFocusCommandId(runtime){
    return runtime.moduleRun ? null : runtime.mode === "cycle"
      ? (runtime.cycleSlot === 1 ? this.plugin.settings.cycleWorkspaceCommandB : this.plugin.settings.cycleWorkspaceCommandA)
      : this.plugin.settings.focusStartCommandId;
  }
  resumeBreakCommand(){
    if (this.plugin.settings.breakStartCommandId) this.plugin.executeStageCommand(this.plugin.settings.breakStartCommandId);
  }
  /** @param {boolean | StartFocusOptions} [options] */
  async startFocus(options){
    /** @type {StartFocusOptions} */
    let opts = { suppressNotify:false, cause:'manual', minutes:null, cycle:false };
    if (typeof options === 'boolean') opts.suppressNotify = options;
    else if (options && typeof options === 'object') opts = Object.assign(opts, options);
    if (this.plugin.runtime.pendingSettlement && !opts.allowPendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    if (this.plugin.runtime.pendingBreakTransition && !opts.allowPendingBreakTransition) {
      new Notice("休息转换待恢复，请重载插件或重置");
      return false;
    }
    if (!opts.allowTransition && (this.plugin.runtime.status !== TIMER_STATUS.IDLE || this.plugin.runtime.attention)) {
      new Notice("当前已有计时，请先完成或重置当前阶段");
      return false;
    }
    const previousRuntime = this.plugin.runtime;
    this.plugin.ensureDayFreshness(false);
    const requestedDurationMs = Number(opts.durationMs);
    const durationMs = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0 ? Math.round(requestedDurationMs) : 0;
    const minutesRaw = typeof opts.minutes === 'number' && isFinite(opts.minutes) && opts.minutes > 0 ? opts.minutes : (this.plugin.settings.focusMin || 25);
    const minutes = durationMs ? durationMs / 60_000 : Math.max(0.1, minutesRaw);
    const effects = this.plugin.applyRuntimeEvent({
      type:RUNTIME_EVENT.START_STAGE,
      stage:TIMER_STAGE.FOCUS,
      durationMs:durationMs || minutes * 60 * 1000,
      now:Date.now(),
      sessionId:createSessionId(),
      mode:opts.cycle ? "cycle" : "standard",
      cycleSlot:opts.cycle ? (opts.cycleSlot === 1 ? 1 : 0) : 0,
      currentTaskName:opts.cycle && opts.taskName !== undefined ? opts.taskName : undefined,
      longFocusMinutes:opts.minutes != null && !opts.cycle ? minutes : undefined,
      cycleRoundCount:opts.cycle && opts.newCycle ? 0 : undefined
    });
    await this.plugin.saveTransition(previousRuntime);
    this.plugin.runRuntimeEffects(effects);
    this.helpers.playBeep(this.plugin.settings.focusStartSound, this.plugin.settings.enableSound, this.plugin.settings.soundWaveform);
    if (!opts.suppressNotify) {
      const task = String(this.plugin.runtime.currentTaskName || this.plugin.settings.defaultTaskName || "").trim();
      this.helpers.sysNotify("开始专注", `${formatTomatoNumber(minutes)} 分钟${task ? ` · 任务：${task}` : ""}`, this.plugin.settings.enableNotify);
    }
    const commandId = opts.cycle
      ? (this.plugin.runtime.cycleSlot === 1 ? this.plugin.settings.cycleWorkspaceCommandB : this.plugin.settings.cycleWorkspaceCommandA)
      : this.plugin.settings.focusStartCommandId;
    if (opts.cause !== 'auto' && commandId) this.plugin.executeStageCommand(commandId);
  }
  /** @param {number} [slot] @param {StartFocusOptions} [options] */
  async startCycle(slot=this.plugin.runtime.cycleSlot, options={}){
    if (this.plugin.runtime.pendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    if (this.plugin.runtime.pendingBreakTransition) {
      new Notice("休息转换待恢复，请重载插件或重置");
      return false;
    }
    if (!options?.allowTransition && (this.plugin.runtime.status !== TIMER_STATUS.IDLE || this.plugin.runtime.attention)) {
      new Notice("当前已有计时，请先完成或重置当前阶段");
      return false;
    }
    const cycleSlot = slot === 1 ? 1 : 0;
    const newCycle = !options?.allowTransition && this.plugin.runtime.status === TIMER_STATUS.IDLE && !this.plugin.runtime.attention;
    const hasTaskSnapshot = Object.prototype.hasOwnProperty.call(options || {}, "taskName");
    const configuredTask = cycleSlot ? this.plugin.settings.cycleTaskB : this.plugin.settings.cycleTaskA;
    const task = String(hasTaskSnapshot ? options.taskName : configuredTask || "").trim();
    const requestedDurationMs = Number(options?.durationMs);
    const minutes = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0
      ? requestedDurationMs / 60_000
      : Number(cycleSlot ? this.plugin.settings.cycleMinB : this.plugin.settings.cycleMinA);
    if (!task) { new Notice(`请先填写任务 ${cycleSlot ? "B" : "A"}`); return; }
    if (!isFinite(minutes) || minutes <= 0) { new Notice(`请设置任务 ${cycleSlot ? "B" : "A"} 的时长`); return; }
    return this.plugin.startFocus(Object.assign({ cause:'manual' }, options, { minutes, cycle:true, cycleSlot, taskName:task, newCycle }));
  }
  /** @param {boolean} [isLong] @param {boolean | StartBreakOptions} [options] */
  async startBreak(isLong=false, options){
    /** @type {StartBreakOptions} */
    let opts = { forceRun:true, suppressNotify:false, cause:'manual' };
    if (typeof options === 'boolean') opts.forceRun = options;
    else if (options && typeof options === 'object') opts = Object.assign(opts, options);
    if (this.plugin.runtime.pendingSettlement && !opts.allowPendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    if (this.plugin.runtime.pendingBreakTransition && !opts.allowPendingBreakTransition) {
      new Notice("休息转换待恢复，请重载插件或重置");
      return false;
    }
    if (!opts.allowTransition && (this.plugin.runtime.status !== TIMER_STATUS.IDLE || this.plugin.runtime.attention)) {
      new Notice("当前已有计时，请先完成或重置当前阶段");
      return false;
    }
    const previousRuntime = this.plugin.runtime;
    this.plugin.ensureDayFreshness(false);
    const requestedDurationMs = Number(opts.durationMs);
    const durationMs = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0
      ? Math.round(requestedDurationMs)
      : Math.max(1, Math.round((isLong ? (this.plugin.settings.longBreakMin||15) : (this.plugin.settings.breakMin||5)) * 60 * 1000));
    const minutes = durationMs / 60_000;
    const forceRun = opts.forceRun ?? true;
    const shouldRun = forceRun !== false && (forceRun || !!this.plugin.settings.autoNext);
    const continuation = normalizeBreakContinuation(opts.breakContinuation);
    const effects = this.plugin.applyRuntimeEvent(shouldRun ? {
      type:RUNTIME_EVENT.START_STAGE,
      stage:TIMER_STAGE.BREAK,
      durationMs,
      now:Date.now(),
      sessionId:null,
      mode:continuation ? "cycle" : "standard",
      cycleSlot:continuation ? continuation.cycleSlot : 0,
      breakContinuation:continuation
    } : {
      type:RUNTIME_EVENT.AWAIT_STAGE,
      durationMs,
      mode:"standard",
      cycleSlot:0,
      breakContinuation:null
    });
    await this.plugin.saveTransition(previousRuntime);
    this.plugin.runRuntimeEffects(effects);
    this.helpers.playBeep(this.plugin.settings.breakStartSound, this.plugin.settings.enableSound, this.plugin.settings.soundWaveform);
    if (!opts.suppressNotify) {
      const task = String(this.plugin.runtime.currentTaskName || this.plugin.settings.defaultTaskName || "").trim();
      this.helpers.sysNotify("开始休息", `${formatTomatoNumber(minutes)} 分钟${task ? ` · 刚完成：${task}` : ""}`, this.plugin.settings.enableNotify);
    }
    if (opts.cause !== 'auto' && this.plugin.settings.breakStartCommandId) this.plugin.executeStageCommand(this.plugin.settings.breakStartCommandId);
  }
  /** @param {any} [options] */
  async completeTask(options){
    const requestedCycleSlot = typeof options === "number"
      ? (options === 1 ? 1 : 0)
      : (options?.cycleSlot === 1 ? 1 : (options?.cycleSlot === 0 ? 0 : null));
    const cycleSlot = requestedCycleSlot === null && this.plugin.runtime.mode === "cycle"
      ? (this.plugin.runtime.cycleSlot === 1 ? 1 : 0)
      : requestedCycleSlot;
    const taskName = cycleSlot === 0
      ? this.plugin.settings.cycleTaskA
      : cycleSlot === 1
        ? this.plugin.settings.cycleTaskB
        : (this.plugin.runtime.currentTaskName || this.plugin.settings.defaultTaskName);
    const task = String(taskName || "").trim();
    if (!task) {
      new Notice("请先选择要完成的任务");
      return false;
    }
    const activeSameName = this.plugin.runtime.stage === TIMER_STAGE.FOCUS
      && /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(this.plugin.runtime.status)
      && String(this.plugin.runtime.currentTaskName || "").trim().toLowerCase() === task.toLowerCase();
    if (activeSameName && !this.plugin.isActiveFocusTask(task, cycleSlot)) {
      new Notice("当前正在执行另一循环项，无法完成同名任务");
      return false;
    }
    try {
      const daily = this.plugin._getDailyRepository();
      const current = await daily.readPath(this.plugin.todayFilePath());
      if (!daily.isFile(current.file)) throw new Error("找不到当天任务文件");
      // Reject missing or ambiguous checkboxes before ending a running focus.
      // The atomic write below checks again in case the note changes meanwhile.
      planTaskLineCompletion(current.text, task);
      if (!(await this.plugin.settleOrEndActiveTaskForCompletion(task, cycleSlot))) {
        new Notice("当前专注尚未安全结算，任务没有标记完成");
        return false;
      }
      await this.plugin._getDailyRepository().completeTask({ taskName:task, path:this.plugin.todayFilePath() });
      await this.plugin.clearCompletedTaskSelection(task, cycleSlot);
      new Notice("任务已完成，日记与任务选择已同步");
      return true;
    } catch (error) {
      this.helpers.logPluginError("complete-task", error, { target:this.plugin.todayFilePath(), step:"daily-checkbox" });
      const message = String(error instanceof Error ? error.message : error);
      new Notice(message.includes("多个同名") ? message : "完成任务失败，请检查当日日记");
      return false;
    }
  }

  /** @param {string} task @param {0|1|null} cycleSlot */
  isActiveFocusTask(task, cycleSlot){
    const isCycle = cycleSlot !== null;
    return this.plugin.runtime.stage === TIMER_STAGE.FOCUS
      && /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(this.plugin.runtime.status)
      && this.plugin.runtime.mode === (isCycle ? "cycle" : "standard")
      && (!isCycle || this.plugin.runtime.cycleSlot === cycleSlot)
      && String(this.plugin.runtime.currentTaskName || "").trim().toLowerCase() === String(task || "").trim().toLowerCase();
  }

  /** @param {string} task @param {0|1|null} cycleSlot */
  async settleOrEndActiveTaskForCompletion(task, cycleSlot){
    if (!this.plugin.isActiveFocusTask(task, cycleSlot)) return true;
    if (this.plugin._completionInFlight) return false;
    if (this.plugin.getElapsedMs() > 0) {
      await this.plugin.settleFocus(true);
      return !this.plugin.runtime.pendingSettlement && this.plugin.runtime.status !== TIMER_STATUS.FAILED;
    }
    return this.plugin.reset(false);
  }

  /** @param {string} task @param {0|1|null} cycleSlot */
  async clearCompletedTaskSelection(task, cycleSlot){
    const normalized = String(task || "").trim();
    if (!normalized) return false;
    /** @param {unknown} value */
    const isSameTask = value => String(value || "").trim().toLowerCase() === normalized.toLowerCase();
    let settingsChanged = false;
    let runtimeChanged = false;
    if (cycleSlot === 0 && isSameTask(this.plugin.settings.cycleTaskA)) {
      Object.assign(this.plugin.settings, { cycleTaskA:"", cycleWorkspaceCommandA:"", cycleTaskBlackoutA:false });
      settingsChanged = true;
    } else if (cycleSlot === 1 && isSameTask(this.plugin.settings.cycleTaskB)) {
      Object.assign(this.plugin.settings, { cycleTaskB:"", cycleWorkspaceCommandB:"", cycleTaskBlackoutB:false });
      settingsChanged = true;
    } else if (cycleSlot === null) {
      if (isSameTask(this.plugin.settings.defaultTaskName)) {
        this.plugin.settings.defaultTaskName = "";
        settingsChanged = true;
      }
      if (this.plugin.settings.taskBlackoutEnabled) {
        this.plugin.settings.taskBlackoutEnabled = false;
        settingsChanged = true;
      }
      runtimeChanged = isSameTask(this.plugin.runtime.currentTaskName);
    }
    if (settingsChanged) await this.plugin.saveSettings();
    if (runtimeChanged) {
      const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.SET_TASK, name:"" });
      await this.plugin.saveState({ critical:true });
      this.plugin.runRuntimeEffects(effects);
    } else if (settingsChanged) {
      this.plugin.broadcast();
    }
    const changed = settingsChanged || runtimeChanged;
    if (changed) this.plugin.app?.workspace?.trigger?.("pomodoro:aio-task-selection-cleared", { taskName:normalized, cycleSlot });
    return changed;
  }

  /** @param {(value:unknown)=>boolean} isCompleted */
  async syncCompletedTaskSelections(isCompleted){
    let changed = false;
      const currentTask = String(this.plugin.runtime.currentTaskName || "").trim();
      const currentSlot = this.plugin.runtime.mode === "cycle" ? (this.plugin.runtime.cycleSlot === 1 ? 1 : 0) : null;
      if (isCompleted(currentTask) && await this.plugin.settleOrEndActiveTaskForCompletion(currentTask, currentSlot)) {
        changed = (await this.plugin.clearCompletedTaskSelection(currentTask, currentSlot)) || changed;
      } else if (isCompleted(this.plugin.settings.defaultTaskName) && await this.plugin.settleOrEndActiveTaskForCompletion(this.plugin.settings.defaultTaskName, null)) {
        changed = (await this.plugin.clearCompletedTaskSelection(this.plugin.settings.defaultTaskName, null)) || changed;
      }
      if (isCompleted(this.plugin.settings.cycleTaskA) && await this.plugin.settleOrEndActiveTaskForCompletion(this.plugin.settings.cycleTaskA, 0)) changed = (await this.plugin.clearCompletedTaskSelection(this.plugin.settings.cycleTaskA, 0)) || changed;
      if (isCompleted(this.plugin.settings.cycleTaskB) && await this.plugin.settleOrEndActiveTaskForCompletion(this.plugin.settings.cycleTaskB, 1)) changed = (await this.plugin.clearCompletedTaskSelection(this.plugin.settings.cycleTaskB, 1)) || changed;
      return changed;
  }
  /** @param {unknown} name */
  setCurrentTaskName(name){
    const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.SET_TASK, name });
    this.plugin.saveState();
    this.plugin.runRuntimeEffects(effects);
  }
  /** @param {unknown} path */
  setCurrentProjectPath(path){
    const rawPath = String(path||"").trim();
    const projectPath = rawPath ? this.helpers.tryNormalizeMarkdownPath(rawPath) : "";
    if (rawPath && !projectPath) { new Notice("项目路径无效"); return false; }
    this.plugin.settings.currentProjectPath = projectPath || "";
    this.plugin.saveSettings(); this.plugin.broadcast();
    return true;
  }
  /** @param {unknown} mode */
  setWorkMode(mode){
    if (this.plugin.runtime.status !== TIMER_STATUS.IDLE || this.plugin.runtime.attention) { new Notice("请先重置当前计时，再切换工作模式"); return false; }
    this.plugin.settings = this.helpers.normalizeSettings({ ...this.plugin.settings, workMode: mode === 'cycle' ? 'cycle' : 'standard' }, this.plugin.settings);
    this.plugin.saveSettings(); this.plugin.broadcast();
    return true;
  }
  /** @param {Partial<Settings>} patch */
  setCycleConfig(patch){
    this.plugin.settings = this.helpers.normalizeSettings({ ...this.plugin.settings, ...patch }, this.plugin.settings);
    this.plugin.saveSettings(); this.plugin.broadcast();
  }
  /** @param {unknown} enabled */
  setTaskBlackoutEnabled(enabled){
    this.plugin.settings = this.helpers.normalizeSettings({ ...this.plugin.settings, taskBlackoutEnabled: enabled === true }, this.plugin.settings);
    this.plugin.saveSettings(); this.plugin.broadcast();
  }
  /** @param {unknown} slot */
  selectCycleSlot(slot){
    if (this.plugin.settings.workMode !== 'cycle' || this.plugin.runtime.status !== TIMER_STATUS.IDLE || this.plugin.runtime.attention) return false;
    const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.SELECT_CYCLE_SLOT, slot });
    this.plugin.saveState();
    this.plugin.runRuntimeEffects(effects);
    return true;
  }
  /** @param {unknown} minutes @param {boolean} [broadcast] */
  setLongFocusMinutes(minutes, broadcast=true){
    const num = Number(minutes);
    if (!isFinite(num)) return;
    const normalized = Math.max(0.1, Math.round(num * 10) / 10);
    const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.SET_LONG_FOCUS, minutes:normalized, broadcast });
    if (broadcast) {
      this.plugin.saveState();
      this.plugin.runRuntimeEffects(effects);
    }
  }

  /** @param {NextPhase} nextPhase */
  async beginStrongAlert(nextPhase){
    const type = nextPhase?.type;
    if (type !== TIMER_STAGE.FOCUS && type !== TIMER_STAGE.BREAK) return;
    const stage = /** @type {TimerStage} */ (type);
    const cycleSlot = Number.isInteger(nextPhase?.cycleSlot) ? (nextPhase.cycleSlot === 1 ? 1 : 0) : null;
    /** @type {Attention} */
    const attention = {
      type:stage,
      isLong: !!nextPhase?.isLong,
      cycleSlot,
      nextStarted: !!nextPhase?.autoStarted,
      durationMs: Math.max(1, Number(nextPhase?.durationMs) || configuredStageDurationMs(this.plugin.settings, stage, !!nextPhase?.isLong, cycleSlot))
    };
    if (nextPhase?.taskName !== undefined) attention.taskName = String(nextPhase.taskName || "").trim();
    if (nextPhase?.moduleRun) {
      const moduleRun = normalizeModuleRun(nextPhase.moduleRun);
      if (moduleRun) attention.moduleRun = moduleRun;
    }
    if (Number.isInteger(nextPhase?.moduleIndex)) attention.moduleIndex = nextPhase.moduleIndex;
    await this.plugin.commitRuntimeEvent({ type:RUNTIME_EVENT.SET_ATTENTION, attention });
  }
  /** @param {unknown} tomatoAmount @param {string} next */
  focusCompletionBody(tomatoAmount, next){
    const task = String(this.plugin.runtime.moduleRun?.name || this.plugin.runtime.currentTaskName || this.plugin.settings.defaultTaskName || "").trim();
    return `${task ? `完成：${task} · ` : ""}+${formatTomatoNumber(tomatoAmount)}🍅\n下一步：${next}`;
  }
  // 当日任务行尾追加对应 🍅 数量，并写入 frontmatter[fmKey]；返回今日累计
  async applyTomatoAndSum(amount=1){
    const result = await this.plugin._getDailyRepository().addTomatoAndSum({
      taskName: this.plugin.runtime.currentTaskName || this.plugin.settings.defaultTaskName,
      amount,
      settings: this.plugin.settings,
      frontmatterKey: this.plugin.settings.fmKey || "番茄数"
    });
    if (result.frontmatterError) {
      this.helpers.logPluginError("daily-settlement", result.frontmatterError, {
        sessionId: this.plugin.runtime.sessionId,
        stage: this.plugin.runtime.stage,
        target: result.file.path,
        step: "frontmatter"
      });
      this.plugin.upsertFrontmatterRepair({
        path: result.file.path,
        key: this.plugin.settings.fmKey || "番茄数",
        expectedSum: result.sum,
        error: String(result.frontmatterError instanceof Error ? result.frontmatterError.message : result.frontmatterError)
      });
      this.plugin.saveState();
      new Notice("当日日记 frontmatter 汇总写入失败，任务行记录已保留");
    }
    this.plugin.broadcast();
    return result.sum;
  }

  // 为所选项目文件 frontmatter[projectFmKey] +1
  async bumpProjectTomato(amount=1){
    if (!this.plugin.settings.projectEnable) return;
    await this.plugin._getProjectRepository().bumpTomato({
      path: this.plugin.settings.currentProjectPath,
      key: this.plugin.settings.projectFmKey,
      amount
    });
  }
  async safeBumpProjectTomato(amount=1){
    try {
      await this.plugin.bumpProjectTomato(amount);
    } catch (err) {
      this.helpers.logPluginError("project-sync", err, {
        sessionId: this.plugin.runtime.sessionId,
        stage: this.plugin.runtime.stage,
        target: this.plugin.settings.currentProjectPath,
        step: "write"
      });
      new Notice("项目番茄同步失败，已保留当日日记记录");
    }
  }

  /* ====== 提供给视图的查询/动作 ====== */
  /** @param {import("../../types/legacy-contracts").LegacySettlementJournal} journal */
  notifyFocusCompletion(journal){
    if (journal.transition.mode === "cycle") {
        const nextTask = Object.prototype.hasOwnProperty.call(journal.transition, "taskName")
          ? String(journal.transition.taskName || "").trim()
          : String((journal.transition.cycleSlot === 1 ? this.plugin.settings.cycleTaskB : this.plugin.settings.cycleTaskA) || "").trim();
        const cycleRestDurationMs = Math.max(0, Number(journal.transition.cycleRestDurationMs) || 0);
        const next = cycleRestDurationMs
          ? `本轮完成，短休 ${formatTomatoNumber(cycleRestDurationMs / 60_000)} 分钟（点击番茄图标开始）`
          : `${nextTask || "下一段专注"}（点击番茄图标开始）`;
        this.helpers.sysNotify(journal.manual ? "专注完成（手动）" : "专注完成", this.plugin.focusCompletionBody(journal.amount, next), this.plugin.settings.enableNotify);
    } else {
        const breakMinutes = journal.transition.durationMs / 60 / 1000;
        this.helpers.sysNotify(journal.manual ? "专注完成（手动）" : "专注完成", this.plugin.focusCompletionBody(journal.amount, `${journal.transition.isLong ? "长休" : "短休"} ${formatTomatoNumber(breakMinutes)} 分钟${journal.transition.autoNext ? "（已开始）" : "（点击番茄图标开始）"}`), this.plugin.settings.enableNotify);
      }
  }
  /** @param {import("../../types/legacy-contracts").LegacySettlementJournal} journal */
  async finalizeFocusTransition(journal){
    if (journal.transition.mode === "cycle") {
      const r = this.plugin.runtime;
      const cycleRestDurationMs = Math.max(0, Number(journal.transition.cycleRestDurationMs) || 0);
      if (cycleRestDurationMs > 0) {
        /** @type {BreakContinuation} */
        const continuation = {
          mode: "cycle",
          cycleSlot: journal.transition.cycleSlot === 1 ? 1 : 0,
          taskName: String(journal.transition.taskName || "").trim(),
          durationMs: Math.max(1, Math.round(Number(journal.transition.durationMs) || 1))
        };
        const existingRest = r.stage === TIMER_STAGE.BREAK
          && r.mode === "cycle"
          && Math.round(Number(r.durationMs) || 0) === Math.round(cycleRestDurationMs)
          && r.breakContinuation?.mode === "cycle"
          && r.breakContinuation?.cycleSlot === continuation.cycleSlot
          && /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED]).includes(r.status)
          && (Number(r.startedAtMs) > 0 || (Number(r.pausedAtMs) > 0 && Number(r.remainingMs) > 0));
        const alreadyAwaiting = r.status === TIMER_STATUS.AWAITING
          && r.attention?.type === TIMER_STAGE.BREAK
          && r.attention?.cycleSlot === continuation.cycleSlot
          && Math.round(Number(r.attention?.durationMs) || 0) === Math.round(cycleRestDurationMs)
          && r.breakContinuation?.mode === "cycle";
        if (!existingRest && !alreadyAwaiting) {
          this.plugin.applyRuntimeEvent({
            type:RUNTIME_EVENT.AWAIT_STAGE,
            durationMs: cycleRestDurationMs,
            mode:"cycle",
            cycleSlot:continuation.cycleSlot,
            breakContinuation:continuation
          });
          await this.plugin.beginStrongAlert({
            type:TIMER_STAGE.BREAK,
            isLong:false,
            autoStarted:false,
            durationMs:cycleRestDurationMs,
            cycleSlot:continuation.cycleSlot,
            taskName:continuation.taskName
          });
        } else if (existingRest && r.status === TIMER_STATUS.SETTLING) {
          this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.RESTORE_ACTIVE_STAGE });
          await this.plugin.beginStrongAlert({
            type:TIMER_STAGE.BREAK,
            isLong:false,
            autoStarted:true,
            durationMs:cycleRestDurationMs,
            cycleSlot:continuation.cycleSlot,
            taskName:continuation.taskName
          });
        } else if (existingRest && !r.attention) {
          await this.plugin.beginStrongAlert({
            type:TIMER_STAGE.BREAK,
            isLong:false,
            autoStarted:true,
            durationMs:cycleRestDurationMs,
            cycleSlot:continuation.cycleSlot,
            taskName:continuation.taskName
          });
        }
      } else {
        const already = r.status === TIMER_STATUS.AWAITING
          && r.attention?.type === TIMER_STAGE.FOCUS
          && r.attention?.cycleSlot === journal.transition.cycleSlot;
        if (!already) {
          this.plugin.applyRuntimeEvent({
            type:RUNTIME_EVENT.AWAIT_STAGE,
            durationMs:journal.transition.durationMs,
            mode:"cycle",
            cycleSlot:journal.transition.cycleSlot
          });
          await this.plugin.beginStrongAlert({ type:TIMER_STAGE.FOCUS, cycleSlot:journal.transition.cycleSlot, taskName:journal.transition.taskName, autoStarted:false, durationMs:journal.transition.durationMs });
        }
      }
    } else {
      const r = this.plugin.runtime;
      const attentionMatches = !r.attention
        || (r.attention.type === TIMER_STAGE.BREAK && !!r.attention.isLong === !!journal.transition.isLong);
      const existingBreak = journal.transition.autoNext
        && r.stage === TIMER_STAGE.BREAK
        && Math.round(Number(r.durationMs) || 0) === Math.round(Number(journal.transition.durationMs) || 0)
        && /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING]).includes(r.status)
        && (Number(r.startedAtMs) > 0 || (Number(r.pausedAtMs) > 0 && Number(r.remainingMs) > 0))
        && attentionMatches;
      const alreadyAwaiting = !journal.transition.autoNext
        && r.status === TIMER_STATUS.AWAITING
        && r.attention?.type === TIMER_STAGE.BREAK
        && !!r.attention?.isLong === !!journal.transition.isLong;
      if (!existingBreak && !alreadyAwaiting) {
        await this.plugin.startBreak(journal.transition.isLong, {
          forceRun: journal.transition.autoNext,
          cause: journal.manual ? "manual" : "auto",
          suppressNotify: true,
          durationMs: journal.transition.durationMs,
          allowTransition: true,
          allowPendingSettlement: true
        });
      } else if (existingBreak && r.status === TIMER_STATUS.SETTLING) {
        this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.RESTORE_ACTIVE_STAGE });
      }
      await this.plugin.beginStrongAlert({
        type:TIMER_STAGE.BREAK,
        isLong:journal.transition.isLong,
        autoStarted:journal.transition.autoNext,
        durationMs:journal.transition.durationMs
      });
    }
    journal.status = "settled";
    await this.plugin.saveState({ critical:true });
    const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.CLEAR_PENDING_SETTLEMENT });
    await this.plugin.saveState({ critical:true });
    this.plugin.runRuntimeEffects(effects);
  }
  /** @param {import("../../types/legacy-contracts").LegacyBreakTransition} transition */
  async advanceBreakTransition(transition){
    const r = this.plugin.runtime;
    const isCycle = transition.mode === "cycle";
    const focusStarted = transition.autoNext
      && r.stage === TIMER_STAGE.FOCUS
      && Math.round(Number(r.durationMs) || 0) === Math.round(transition.durationMs)
      && (/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.FAILED]).includes(r.status) && Number(r.startedAtMs) > 0
        || /** @type {string[]} */ ([TIMER_STATUS.PAUSED, TIMER_STATUS.FAILED]).includes(r.status) && Number(r.pausedAtMs) > 0 && Number(r.remainingMs) > 0);
    if (focusStarted && r.status === TIMER_STATUS.FAILED) {
      this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.RESTORE_FOCUS });
    }
    if (transition.autoNext && !focusStarted) {
      if (isCycle && Number.isInteger(transition.cycleSlot)) {
        await this.plugin.startCycle(transition.cycleSlot === 1 ? 1 : 0, {
          suppressNotify:true,
          cause:'auto',
          allowTransition:true,
          allowPendingBreakTransition:true,
          durationMs:transition.durationMs,
          taskName:transition.taskName
        });
      } else {
        await this.plugin.startFocus({
          suppressNotify:true,
          cause:'auto',
          allowTransition:true,
          allowPendingBreakTransition:true,
          durationMs:transition.durationMs
        });
      }
    }
    await this.plugin.beginStrongAlert({
      type:TIMER_STAGE.FOCUS,
      autoStarted:transition.autoNext,
      durationMs:transition.durationMs,
      cycleSlot:isCycle && Number.isInteger(transition.cycleSlot) ? transition.cycleSlot : null,
      taskName:isCycle ? transition.taskName : undefined
    });
    const previousRuntime = this.plugin.runtime;
    const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.CLEAR_BREAK_TRANSITION });
    await this.plugin.saveTransition(previousRuntime);
    this.plugin.runRuntimeEffects(effects);
  }
  async settleBreak(){
    const r = this.plugin.runtime;
    /** @type {BreakContinuation | null} */
    const cycleContinuation = r.breakContinuation?.mode === "cycle" ? r.breakContinuation : null;
    /** @type {BreakTransition} */
    const transition = {
      schemaVersion:1,
      status:"break-completing",
      autoNext:cycleContinuation ? false : !!this.plugin.settings.autoNext,
      durationMs:cycleContinuation
        ? cycleContinuation.durationMs
        : configuredStageDurationMs(this.plugin.settings, TIMER_STAGE.FOCUS),
      createdAtMs:Date.now()
    };
    if (cycleContinuation) {
      transition.mode = "cycle";
      transition.cycleSlot = cycleContinuation.cycleSlot;
      transition.taskName = cycleContinuation.taskName;
    }
    const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.BEGIN_BREAK_TRANSITION, transition });
    try {
      await this.plugin.saveState({ critical:true });
      this.plugin.runRuntimeEffects(effects);
      this.helpers.playBeep(this.plugin.settings.breakEndSound, this.plugin.settings.enableSound, this.plugin.settings.soundWaveform);
      const task = transition.mode === "cycle"
        ? String(transition.taskName || "").trim()
        : String(this.plugin.runtime.currentTaskName || this.plugin.settings.defaultTaskName || "").trim();
      this.helpers.sysNotify("休息结束", `下一步：${transition.autoNext ? "已开始" : "点击番茄图标开始"}专注${task ? ` · 任务：${task}` : ""}`, this.plugin.settings.enableNotify);
      await this.plugin.advanceBreakTransition(transition);
    } catch (error) {
      this.plugin.markSettlementFailed(error, { operation:"settleBreak", step:"advanceFocus" });
    } finally {
      this.plugin._completionInFlight = false;
    }
  }
  settlementTaskName(){ return this.plugin.runtime.currentTaskName || this.plugin.settings.defaultTaskName || ""; }
  /** @param {number} amount */
  prepareProjectSettlement(amount){
    return this.plugin._getProjectRepository().prepareSettlementPlan({
      path:this.plugin.settings.currentProjectPath,
      key:this.plugin.settings.projectFmKey,
      amount,
      enabled:this.plugin.settings.projectEnable
    });
  }
}
module.exports = { LegacyRuntimeController };
