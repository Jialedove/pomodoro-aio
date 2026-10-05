const { Notice, TFile } = require("obsidian");
const { normalizeTomatoValue } = require("../core/validation");
const { settlementConflict, getTomatoSum } = require("../core/task-lines");
const { TIMER_STATUS, TIMER_STAGE, plannedTomatoAmount, actualTomatoAmount, createSessionId } = require("../core/timer");
const { RUNTIME_EVENT } = require("../core/state-machine");
const { buildDailySettlementPlan, buildSettlementJournal } = require("../core/settlement");
const { createModuleRunSnapshot, getNextModule } = require("../core/modules");
const { cloneValue } = require("../services/runtime-store");
const { normalizeModuleRun } = require("../legacy/runtime-normalization");
/** @typedef {import("../../types/contracts").Runtime} Runtime */
/** @typedef {import("../../types/contracts").BreakTransition} BreakTransition */
/** @typedef {import("../../types/contracts").ProjectSettlementPlan} ProjectSettlementPlan */
/** @typedef {import("../../types/contracts").SettlementJournal} SettlementJournal */
/** @typedef {import("../../types/contracts").StageTransition} StageTransition */
/** @typedef {Record<string, any>} AnyRecord */

class SettlementCoordinator {
  /** @param {any} plugin @param {{playBeep:Function,sysNotify:Function,logPluginError:Function}} helpers */
  constructor(plugin, helpers) {
    this.plugin = plugin;
    this.helpers = helpers;
  }
  async completeEmptyWorkModule(){
    const r = this.plugin.runtime;
    if (this.plugin._completionInFlight || r.moduleRun?.type !== "work"
      || !/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(r.status)) return false;
    this.plugin._completionInFlight = true;
    const next = this.plugin.buildModuleTransition(r, "work");
    /** @type {BreakTransition} */
    const transition = {
      schemaVersion:1, status:"break-completing", mode:"modules", completionType:"work",
      autoNext:next.autoNext, durationMs:next.durationMs, createdAtMs:Date.now(),
      moduleIndex:next.moduleIndex, moduleRun:next.moduleRun,
      completedWorkCountAfter:next.completedWorkCountAfter,
      sessionCountAfter:(r.sessionCount || 0) + 1,
      completedLoopCountAfter:next.completedLoopCountAfter
    };
    const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.BEGIN_BREAK_TRANSITION, transition });
    try {
      await this.plugin.saveState({ critical:true });
      this.plugin.runRuntimeEffects(effects);
      await this.plugin.advanceBreakTransition(transition);
      new Notice("本段已完成；有效工作时长为 0，未记番茄");
      return true;
    } catch (error) {
      this.plugin.markSettlementFailed(error, { operation:"completeEmptyWork", step:"advance" });
      return false;
    } finally { this.plugin._completionInFlight = false; }
  }

  /** @param {boolean} [manual] */
  async settleFocus(manual=false){
    const r = this.plugin.runtime;
    if (this.plugin._completionInFlight || !/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(r.status) || r.stage !== TIMER_STAGE.FOCUS) return;
    this.plugin._completionInFlight = true;
    const elapsedMs = this.plugin.getElapsedMs();
    const tomatoAmount = manual ? actualTomatoAmount(elapsedMs) : plannedTomatoAmount(r.durationMs);
    const settlementEffects = this.plugin.applyRuntimeEvent({
      type:RUNTIME_EVENT.BEGIN_FOCUS_SETTLEMENT,
      sessionId:r.sessionId || createSessionId()
    });
    try {
      const current = this.plugin.runtime;
      if (!current.pendingSettlement || current.pendingSettlement.sessionId !== current.sessionId) {
        const sessionCountAfter = (current.sessionCount || 0) + 1;
        const transition = current.moduleRun
          ? this.plugin.buildModuleTransition(current, "work")
          : this.plugin._getLegacyController().buildNextStageTransition(current, sessionCountAfter);
        const journal = await this.plugin.prepareSettlement(tomatoAmount, transition, sessionCountAfter, manual);
        this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.SET_PENDING_SETTLEMENT, journal });
        await this.plugin.saveState({ critical:true });
      }
      this.plugin.runRuntimeEffects(settlementEffects);
      await this.plugin.resumePendingSettlement();
    } catch (error) {
      this.plugin.markSettlementFailed(error, { operation:"settleFocus", step:"prepareOrResume" });
    } finally {
      this.plugin._completionInFlight = false;
    }
  }
  /** @param {Runtime} runtime @param {"work"|"rest"} completedType @returns {StageTransition} */
  buildModuleTransition(runtime, completedType){
    const modules = this.plugin.settings.modules || [];
    if (runtime.moduleRun?.recoveryOnly) return {
      mode:"modules", durationMs:1, autoNext:false, moduleIndex:null, moduleRun:null,
      completedWorkCountAfter:(runtime.completedWorkCount || 0) + (completedType === "work" ? 1 : 0),
      completedRestCountAfter:(runtime.completedRestCount || 0) + (completedType === "rest" ? 1 : 0),
      completedLoopCountAfter:runtime.completedLoopCount || 0
    };
    const found = modules.findIndex((/** @type {{id:string}} */ item) => item.id === runtime.moduleRun?.moduleId);
    const index = found >= 0 ? found : Math.min(runtime.currentModuleIndex || 0, modules.length - 1);
    const position = getNextModule(modules, index, runtime.completedLoopCount || 0, this.plugin.settings);
    const nextDefinition = position.nextIndex !== null ? modules[position.nextIndex] : null;
    const nextRun = nextDefinition ? createModuleRunSnapshot(nextDefinition, this.plugin.settings.projectAssignments,
      { enableProjects:this.plugin.settings.enableProjects, startedAtMs:Date.now() }) : null;
    return {
      mode:"modules",
      durationMs:nextRun?.durationMs || 1,
      autoNext:!!this.plugin.settings.autoAdvance && !!nextRun,
      moduleIndex:nextRun ? position.nextIndex : null,
      moduleRun:nextRun,
      completedWorkCountAfter:(runtime.completedWorkCount || 0) + (completedType === "work" ? 1 : 0),
      completedRestCountAfter:(runtime.completedRestCount || 0) + (completedType === "rest" ? 1 : 0),
      completedLoopCountAfter:position.completedLoopCount
    };
  }
  /** @param {number} amount @param {StageTransition} transition @param {number} sessionCountAfter @param {boolean} [manual] @returns {Promise<SettlementJournal>} */
  async prepareSettlement(amount, transition, sessionCountAfter, manual=false){
    const path = this.plugin.todayFilePath();
    const dailyRepository = this.plugin._getDailyRepository();
    const { text: sourceText } = await dailyRepository.readPath(path);
    const taskName = String(this.plugin.runtime.moduleRun?.name || this.plugin._getLegacyController().settlementTaskName()).trim();
    const daily = buildDailySettlementPlan(sourceText, {
      path,
      taskName,
      frontmatterKey: this.plugin.settings.fmKey || "番茄数",
      amount,
      settings: this.plugin.settings
    });
    return buildSettlementJournal({
      sessionId: this.plugin.runtime.sessionId || createSessionId(),
      durationMs: this.plugin.runtime.durationMs,
      taskName,
      amount,
      manual,
      sessionCountAfter,
      transition,
      createdAtMs: Date.now(),
      daily,
      project: await this.plugin.prepareProjectSettlement(amount)
    });
  }
  /** @param {number} amount @returns {Promise<ProjectSettlementPlan>} */
  async prepareProjectSettlement(amount){
    if (this.plugin.runtime.moduleRun) {
      const projectPath = this.plugin.runtime.moduleRun.projectPath || "";
      const key = this.plugin.settings.projectFmKey || "番茄数";
      if (!this.plugin.settings.enableProjects || !projectPath) return { path:"", key, amount, status:"skipped" };
      try {
        return await this.plugin._getProjectRepository().prepareSettlementPlan({
          path:projectPath, key, amount, enabled:true
        });
      } catch (error) {
        this.helpers.logPluginError("project-plan", error, { sessionId:this.plugin.runtime.sessionId, stage:this.plugin.runtime.stage, target:projectPath, step:"prepare" });
        return { path:projectPath, key, amount, status:"missing", deferred:true };
      }
    }
    return this.plugin._getLegacyController().prepareProjectSettlement(amount);
  }
  /** @param {SettlementJournal} journal */
  async applyDailySettlement(journal){
    const daily = journal.daily;
    if (!daily || !daily.path) throw new Error("结算 journal 缺少日记写入计划");
    const dailyRepository = this.plugin._getDailyRepository();
    let file = dailyRepository.getFile(daily.path);
    if (!file) {
      if (daily.rowStatus === "applied") throw settlementConflict("已完成的日记文件不存在，无法安全恢复");
      file = await dailyRepository.ensureFileAtPath(daily.path);
    }
    if (!dailyRepository.isFile(file)) throw new Error("当天路径不是文件");

    let currentText = "";
    if (daily.rowStatus !== "applied") {
      let mutation;
      try {
        mutation = await dailyRepository.applyPlannedMutation(file, daily);
      } catch (error) {
        if (daily.kind !== "insert"
          || !error || typeof error !== "object" || !("code" in error) || error.code !== "SETTLEMENT_CONFLICT") throw error;
        const rebased = buildDailySettlementPlan(await dailyRepository.read(file), {
          path:daily.path,
          taskName:daily.taskName,
          frontmatterKey:daily.frontmatterKey,
          amount:journal.amount,
          settings:{ ...this.plugin.settings, allowAutoCreateTask:true, tasksHeading:daily.heading || "" }
        });
        Object.assign(daily, rebased);
        await this.plugin.saveState({ critical:true });
        mutation = await dailyRepository.applyPlannedMutation(file, daily);
      }
      currentText = mutation.text;
      daily.rowStatus = "applied";
      daily.alreadyApplied = mutation.alreadyApplied;
    }
    if (!currentText) currentText = await dailyRepository.read(file);
    daily.expectedSum = getTomatoSum(currentText);
    if (daily.frontmatterStatus !== "applied") {
      try {
        await dailyRepository.processFrontMatter(file, (/** @type {Record<string, any>} */ fm)=>{ fm[daily.frontmatterKey] = daily.expectedSum; });
        daily.frontmatterStatus = "applied";
        this.plugin.removeFrontmatterRepair(daily.path, daily.frontmatterKey);
      } catch (error) {
        daily.frontmatterStatus = "pending";
        daily.frontmatterError = String(error instanceof Error ? error.message : error);
        this.helpers.logPluginError("daily-settlement", error, {
          sessionId: journal.sessionId,
          stage: journal.stage,
          target: daily.path,
          step: "frontmatter"
        });
        this.plugin.upsertFrontmatterRepair({
          sessionId: journal.sessionId,
          path: daily.path,
          key: daily.frontmatterKey,
          expectedSum: daily.expectedSum,
          error: daily.frontmatterError
        });
        new Notice("日记任务已记录，但汇总字段待修复");
      }
    }
    journal.status = "dailyApplied";
    await this.plugin.saveState({ critical:true });
  }
  /** @param {ProjectSettlementPlan} plan */
  async applyProjectPlan(plan){
    return this.plugin._getProjectRepository().applyPlan(plan);
  }
  /** @param {SettlementJournal} journal */
  async applyProjectSettlement(journal){
    const project = journal.project;
    if (journal.transition.mode === "modules" && !this.plugin.settings.enableProjects && project && project.status !== "applied") {
      project.status = "skipped";
      journal.status = "projectApplied";
      await this.plugin.saveState({ critical:true });
      return;
    }
    if (!project || project.status === "skipped") {
      journal.status = "projectApplied";
      await this.plugin.saveState({ critical:true });
      return;
    }
    const hasPredecessor = project.status !== "applied" && (this.plugin.runtime.projectQueue || []).some(
      (/** @type {AnyRecord} */ item) => item.sessionId !== journal.sessionId
        && item.path === project.path && item.key === project.key
    );
    if (hasPredecessor) {
      // Earlier credits must be retried first: both plans may have the same
      // frontmatter baseline while the project was unavailable.
      this.plugin.upsertProjectRetry({ ...project, sessionId:journal.sessionId });
      journal.status = "projectApplied";
      await this.plugin.saveState({ critical:true });
      return;
    }
    const result = await this.plugin.applyProjectPlan(project);
    project.status = result.status;
    if (result.error) project.error = result.error;
    if (result.error) {
      this.helpers.logPluginError("project-settlement", new Error(result.error), {
        sessionId: journal.sessionId,
        stage: journal.stage,
        target: project.path,
        step: result.status === "conflict" ? "conflict" : "write"
      });
    }
    if (result.status === "applied") {
      this.plugin.removeProjectRetry(project.sessionId || journal.sessionId, project.path);
      this.plugin.notifyProjectUpdated(project);
    }
    else this.plugin.upsertProjectRetry({ ...project, sessionId: journal.sessionId });
    journal.status = "projectApplied";
    await this.plugin.saveState({ critical:true });
  }
  /** @param {AnyRecord} item */
  upsertProjectRetry(item){
    const queue = this.plugin.runtime.projectQueue || (this.plugin.runtime.projectQueue = []);
    const copy = cloneValue(item);
    const index = queue.findIndex((/** @type {AnyRecord} */ entry)=> entry.sessionId === copy.sessionId && entry.path === copy.path);
    if (index === -1) queue.push(copy);
    else queue[index] = copy;
  }
  /** @param {unknown} sessionId @param {unknown} path */
  removeProjectRetry(sessionId, path){
    this.plugin.runtime.projectQueue = (this.plugin.runtime.projectQueue || []).filter((/** @type {AnyRecord} */ item)=> !(item.sessionId === sessionId && item.path === path));
  }
  /** @param {ProjectSettlementPlan} plan */
  notifyProjectUpdated(plan){
    const tomatoes = Number(plan.afterValue);
    if (plan.path && Number.isFinite(tomatoes)) {
      this.plugin.app?.workspace?.trigger?.("pomodoro:aio-project-updated", { path:plan.path, tomatoes });
    }
  }
  /** @param {AnyRecord[]} queue @param {number} startIndex @param {AnyRecord} predecessor */
  rebaseProjectSuccessors(queue, startIndex, predecessor){
    if (predecessor.afterValue === undefined) return;
    const key = `${predecessor.path}\u0000${predecessor.key}`;
    let afterValue = normalizeTomatoValue(predecessor.afterValue);
    for (let i=startIndex; i<queue.length; i++) {
      const item = queue[i];
      if (`${item.path}\u0000${item.key}` !== key) continue;
      const amount = Math.max(0, Number(item.amount) || 0);
      item.beforeValue = afterValue;
      item.afterValue = normalizeTomatoValue(afterValue + amount);
      item.deferred = false;
      afterValue = item.afterValue;
    }
  }
  /** @param {AnyRecord} item */
  upsertFrontmatterRepair(item){
    const queue = this.plugin.runtime.frontmatterQueue || (this.plugin.runtime.frontmatterQueue = []);
    const copy = cloneValue(item);
    const index = queue.findIndex((/** @type {AnyRecord} */ entry)=> entry.sessionId === copy.sessionId && entry.path === copy.path && entry.key === copy.key);
    if (index === -1) queue.push(copy);
    else queue[index] = copy;
  }
  /** @param {unknown} path @param {unknown} key @param {unknown} [sessionId] */
  removeFrontmatterRepair(path, key, sessionId){
    this.plugin.runtime.frontmatterQueue = (this.plugin.runtime.frontmatterQueue || []).filter((/** @type {AnyRecord} */ item)=> !(item.path === path && item.key === key && (!sessionId || item.sessionId === sessionId)));
  }
  async repairFrontmatterQueue(){
    const dailyRepository = this.plugin._getDailyRepository();
    const queue = this.plugin.runtime.frontmatterQueue || [];
    let changed = false;
    for (let i=queue.length-1; i>=0; i--) {
      const item = queue[i];
      try {
        const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
        if (!file || !(file instanceof TFile)) continue;
        item.expectedSum = getTomatoSum(await dailyRepository.read(file));
        await dailyRepository.processFrontMatter(file, (/** @type {Record<string, any>} */ fm)=>{ fm[item.key] = normalizeTomatoValue(item.expectedSum); });
        queue.splice(i, 1);
        changed = true;
      } catch (error) {
        item.error = String(error instanceof Error ? error.message : error);
        changed = true;
        this.helpers.logPluginError("frontmatter-repair", error, {
          sessionId: item.sessionId,
          stage: TIMER_STAGE.FOCUS,
          target: item.path,
          step: "retry"
        });
      }
    }
    if (changed) await this.plugin.saveState();
  }
  async drainProjectQueue(){
    if (Array.isArray(this.plugin.settings.modules) && !this.plugin.settings.enableProjects) return;
    const queue = this.plugin.runtime.projectQueue || [];
    // A previous failed checkpoint may have left rebased successors in memory.
    // Make that baseline durable before a same-process retry writes more credit.
    if (queue.length) await this.plugin.saveState({ critical:true });
    let changed = false;
    let i = 0;
    const blockedKeys = new Set();
    while (i < queue.length) {
      const item = queue[i];
      const key = `${item.path}\u0000${item.key}`;
      if (blockedKeys.has(key)) {
        i += 1;
        continue;
      }
      let result;
      if (item.deferred && item.beforeValue === undefined && !["applied", "skipped"].includes(item.status)) {
        let prepared;
        try {
          prepared = await this.plugin._getProjectRepository().prepareSettlementPlan({
            path:item.path, key:item.key, amount:item.amount, enabled:true
          });
        } catch (error) {
          result = { status:"pending", error:String(error instanceof Error ? error.message : error) };
        }
        if (prepared?.status === "pending") {
          Object.assign(item, prepared, { deferred:false });
          // Resolve a formerly missing project's baseline before its first
          // write, so an interrupted retry can recognize an applied credit.
          await this.plugin.saveState({ critical:true });
        } else if (prepared) {
          result = { status:prepared.status, error:"项目文件不存在" };
        }
      }
      if (!result) {
        try {
          result = await this.plugin.applyProjectPlan(/** @type {ProjectSettlementPlan} */ (item));
        } catch (error) {
          result = { status: "pending", error: String(error instanceof Error ? error.message : error) };
        }
      }
      item.status = result.status;
      if (result.error) item.error = result.error;
      if (result.error) {
        this.helpers.logPluginError("project-retry", new Error(result.error), {
          sessionId: item.sessionId,
          stage: TIMER_STAGE.FOCUS,
          target: item.path,
          step: result.status === "conflict" ? "conflict" : "retry"
        });
      }
      if (result.status === "applied" || result.status === "skipped") {
        if (result.status === "applied") {
          this.plugin.rebaseProjectSuccessors(queue, i + 1, item);
        }
        queue.splice(i, 1);
        // Persist removal and rebased successors before writing another credit.
        // A failed checkpoint must stop the drain at this recoverable boundary.
        await this.plugin.saveState({ critical:true });
        changed = false;
        if (result.status === "applied") this.plugin.notifyProjectUpdated(/** @type {ProjectSettlementPlan} */ (item));
      } else {
        blockedKeys.add(key);
        i += 1;
        changed = true;
      }
    }
    if (changed) await this.plugin.saveState();
  }
  /** @param {SettlementJournal} journal */
  async finalizeFocusSettlement(journal){
    this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.FINALIZE_SETTLEMENT, journal });
    journal.status = "runtimeFinalizing";
    await this.plugin.saveState({ critical:true });

    if (!journal.notified) {
      this.helpers.playBeep(this.plugin.settings.focusEndSound, this.plugin.settings.enableSound, this.plugin.settings.soundWaveform);
      if (journal.transition.mode === "modules") {
        const nextRun = journal.transition.moduleRun;
        this.helpers.sysNotify(journal.manual ? "工作段完成（手动）" : "工作段完成",
          this.plugin.focusCompletionBody(journal.amount, nextRun ? `${nextRun.name}${journal.transition.autoNext ? "（已开始）" : "（等待确认）"}` : "序列已完成"),
          this.plugin.settings.enableNotify);
      } else {
        this.plugin._getLegacyController().notifyFocusCompletion(journal);
      }
      journal.notified = true;
      await this.plugin.saveState({ critical:true });
    }

    if (journal.transition.mode === "modules") {
      const nextRun = normalizeModuleRun(journal.transition.moduleRun);
      const nextIndex = journal.transition.moduleIndex;
      if (!nextRun || !Number.isInteger(nextIndex)) {
        if (this.plugin.runtime.status !== TIMER_STATUS.IDLE) this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.FINISH_SEQUENCE });
      } else if (journal.transition.autoNext) {
        const alreadyRunning = this.plugin.runtime.moduleRun?.runId === nextRun.runId
          && /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED]).includes(this.plugin.runtime.status);
        if (!alreadyRunning) await this.plugin.startModule(Number(nextIndex), {
          moduleRun:nextRun, allowTransition:true, allowPendingSettlement:true, suppressNotify:true
        });
        else if (/** @type {string[]} */ ([TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED]).includes(this.plugin.runtime.status)) {
          this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.RESTORE_ACTIVE_STAGE });
        }
      } else {
        const alreadyAwaiting = this.plugin.runtime.status === TIMER_STATUS.AWAITING
          && this.plugin.runtime.attention?.moduleRun?.runId === nextRun.runId;
        if (!alreadyAwaiting) {
          this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.AWAIT_STAGE,
            durationMs:nextRun.durationMs, mode:"modules", moduleIndex:nextIndex });
          await this.plugin.beginStrongAlert({ type:nextRun.type === "work" ? TIMER_STAGE.FOCUS : TIMER_STAGE.BREAK,
            autoStarted:false, durationMs:nextRun.durationMs, moduleIndex:Number(nextIndex), moduleRun:nextRun });
        }
      }
      journal.status = "settled";
      await this.plugin.saveState({ critical:true });
      const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.CLEAR_PENDING_SETTLEMENT });
      await this.plugin.saveState({ critical:true });
      this.plugin.runRuntimeEffects(effects);
      return;
    }

    return this.plugin._getLegacyController().finalizeFocusTransition(journal);
  }
  async resumePendingSettlement(){
    const journal = this.plugin.runtime.pendingSettlement;
    if (!journal) return;
    const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.RESUME_SETTLEMENT, journal });
    this.plugin.runRuntimeEffects(effects);
    await this.plugin.applyDailySettlement(journal);
    await this.plugin.applyProjectSettlement(journal);
    await this.plugin.finalizeFocusSettlement(journal);
  }
  async recoverPendingSettlement(){
    if (!this.plugin.runtime.pendingSettlement) return;
    this.plugin._completionInFlight = true;
    try {
      await this.plugin.resumePendingSettlement();
    } catch (error) {
      this.plugin.markSettlementFailed(error, { operation:"recoverPendingSettlement", step:"resume" });
    } finally {
      this.plugin._completionInFlight = false;
    }
  }
  /** @param {BreakTransition} transition */
  async advanceBreakTransition(transition){
    if (transition.mode === "modules") {
      this.plugin.applyRuntimeEvent(transition.completionType === "work"
        ? { type:RUNTIME_EVENT.COMPLETE_EMPTY_WORK,
          completedWorkCountAfter:transition.completedWorkCountAfter,
          sessionCountAfter:transition.sessionCountAfter,
          completedLoopCountAfter:transition.completedLoopCountAfter }
        : { type:RUNTIME_EVENT.COMPLETE_REST,
          completedRestCountAfter:transition.completedRestCountAfter,
          completedLoopCountAfter:transition.completedLoopCountAfter });
      const nextRun = normalizeModuleRun(transition.moduleRun);
      const nextIndex = transition.moduleIndex;
      if (!nextRun || !Number.isInteger(nextIndex)) {
        if (this.plugin.runtime.status !== TIMER_STATUS.IDLE) this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.FINISH_SEQUENCE });
      } else if (transition.autoNext) {
        const alreadyRunning = this.plugin.runtime.moduleRun?.runId === nextRun.runId
          && /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED]).includes(this.plugin.runtime.status);
        if (!alreadyRunning) await this.plugin.startModule(Number(nextIndex), {
          moduleRun:nextRun, allowTransition:true, allowPendingBreakTransition:true, suppressNotify:true
        });
        else if (this.plugin.runtime.status === TIMER_STATUS.FAILED) this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.RESTORE_FOCUS });
      } else {
        const alreadyAwaiting = this.plugin.runtime.status === TIMER_STATUS.AWAITING
          && this.plugin.runtime.attention?.moduleRun?.runId === nextRun.runId;
        if (!alreadyAwaiting) {
          this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.AWAIT_STAGE,
            durationMs:nextRun.durationMs, mode:"modules", moduleIndex:nextIndex });
          await this.plugin.beginStrongAlert({ type:nextRun.type === "work" ? TIMER_STAGE.FOCUS : TIMER_STAGE.BREAK,
            autoStarted:false, durationMs:nextRun.durationMs, moduleIndex:Number(nextIndex), moduleRun:nextRun });
        }
      }
      const previousRuntime = this.plugin.runtime;
      const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.CLEAR_BREAK_TRANSITION });
      await this.plugin.saveTransition(previousRuntime);
      this.plugin.runRuntimeEffects(effects);
      return;
    }
    return this.plugin._getLegacyController().advanceBreakTransition(transition);
  }
  async recoverPendingBreakTransition(){
    const transition = this.plugin.runtime.pendingBreakTransition;
    if (!transition) return;
    this.plugin._completionInFlight = true;
    try {
      await this.plugin.advanceBreakTransition(transition);
    } catch (error) {
      this.plugin.markSettlementFailed(error, { operation:"recoverBreakTransition", step:"advanceFocus" });
    } finally {
      this.plugin._completionInFlight = false;
    }
  }
  async settleBreak(manual=false){
    const r = this.plugin.runtime;
    if (this.plugin._completionInFlight || !/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(r.status) || r.stage !== TIMER_STAGE.BREAK) return;
    this.plugin._completionInFlight = true;
    if (r.moduleRun) {
      const next = this.plugin.buildModuleTransition(r, "rest");
      /** @type {BreakTransition} */
      const transition = {
        schemaVersion:1, status:"break-completing", mode:"modules",
        autoNext:next.autoNext, durationMs:next.durationMs, createdAtMs:Date.now(),
        moduleIndex:next.moduleIndex, moduleRun:next.moduleRun,
        completedRestCountAfter:next.completedRestCountAfter,
        completedLoopCountAfter:next.completedLoopCountAfter
      };
      const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.BEGIN_BREAK_TRANSITION, transition });
      try {
        await this.plugin.saveState({ critical:true });
        this.plugin.runRuntimeEffects(effects);
        this.helpers.playBeep(this.plugin.settings.breakEndSound, this.plugin.settings.enableSound, this.plugin.settings.soundWaveform);
        this.helpers.sysNotify(manual ? "休息段完成（手动）" : "休息段完成",
          next.moduleRun ? `下一项：${next.moduleRun.name}${next.autoNext ? "（已开始）" : "（等待确认）"}` : "序列已完成",
          this.plugin.settings.enableNotify);
        await this.plugin.advanceBreakTransition(transition);
      } catch (error) {
        this.plugin.markSettlementFailed(error, { operation:"settleRestModule", step:"advance" });
      } finally { this.plugin._completionInFlight = false; }
      return;
    }
    return this.plugin._getLegacyController().settleBreak(manual);
  }
  /** @param {unknown} error @param {{operation?:string, sessionId?:string|null, stage?:string|null, target?:string|null, step?:string|null}} [context] */
  markSettlementFailed(error, context={}){
    const r = this.plugin.runtime;
    const details = this.helpers.logPluginError(context.operation || "settlement", error, {
      ...context,
      sessionId: context.sessionId || r.sessionId || r.pendingSettlement?.sessionId,
      stage: context.stage || r.stage || r.pendingSettlement?.stage,
      target: context.target || r.pendingSettlement?.daily?.path || r.pendingSettlement?.project?.path
    });
    const effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.FAIL, failure:{
      ...details,
      atMs: Date.now(),
      message: details.error
    } });
    this.plugin.saveState();
    this.plugin.runRuntimeEffects(effects);
    new Notice("结算失败，journal 已保留，请重载插件恢复");
  }

}

module.exports = { SettlementCoordinator };
