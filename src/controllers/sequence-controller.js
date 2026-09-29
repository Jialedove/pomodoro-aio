const { Notice } = require("obsidian");
const { TIMER_STATUS, TIMER_STAGE } = require("../core/timer");
const { RUNTIME_EVENT } = require("../core/state-machine");
const { createModuleRunSnapshot } = require("../core/modules");
const { formatTomatoNumber } = require("../core/validation");
const { normalizeModuleRun } = require("../legacy/runtime-normalization");
/** @typedef {Record<string, any>} AnyRecord */

class SequenceController {
  /** @param {any} plugin @param {{playBeep:Function,sysNotify:Function,logPluginError:Function}} helpers */
  constructor(plugin, helpers) {
    this.plugin = plugin;
    this.helpers = helpers;
  }
  /** @param {number | AnyRecord} [indexOrOptions] @param {AnyRecord} [options] */
  async startSequence(indexOrOptions, options={}){
    const selectedIndex = this.plugin.settings.modules.findIndex((/** @type {{id:string}} */ item) => item.id === this.plugin.runtime.selectedModuleId);
    const index = typeof indexOrOptions === "number" ? indexOrOptions
      : selectedIndex >= 0 ? selectedIndex : this.plugin.runtime.currentModuleIndex || 0;
    if (typeof indexOrOptions === "object") options = indexOrOptions;
    if (this.plugin.runtime.attention?.moduleRun && Number.isInteger(this.plugin.runtime.attention.moduleIndex)) {
      return this.plugin.startPendingStage();
    }
    if (this.plugin.runtime.status !== TIMER_STATUS.IDLE || this.plugin.runtime.attention) {
      new Notice("当前已有计时，请先完成或重置当前模块"); return false;
    }
    if (!this.plugin.settings.modules.length) { new Notice("请先添加工作或休息模块"); return false; }
    return this.plugin.startModule(index, { ...options, newSequence:true });
  }
  /** @param {number} index */
  async selectModule(index){
    const definition = this.plugin.settings.modules[index];
    if (!Number.isInteger(index) || !definition) { new Notice("请选择有效的工作或休息模块"); return false; }
    if (this.plugin.runtime.pendingSettlement || this.plugin.runtime.pendingBreakTransition) {
      new Notice("当前结算尚未完成，请先恢复结算"); return false;
    }
    const idle = this.plugin.runtime.status === TIMER_STATUS.IDLE && !this.plugin.runtime.attention;
    const awaiting = this.plugin.runtime.status === TIMER_STATUS.AWAITING && !!this.plugin.runtime.attention?.moduleRun;
    if (!idle && !awaiting) {
      new Notice("正在执行当前模块，请先完成本段或重置后选择"); return false;
    }
    const run = awaiting ? createModuleRunSnapshot(definition, this.plugin.settings.projectAssignments,
      { enableProjects:this.plugin.settings.enableProjects, startedAtMs:Date.now() }) : null;
    const attention = run ? {
      type:run.type === "work" ? TIMER_STAGE.FOCUS : TIMER_STAGE.BREAK,
      nextStarted:false,
      durationMs:run.durationMs, moduleIndex:index, moduleRun:run
    } : null;
    try {
      await this.plugin.commitRuntimeEvent({ type:RUNTIME_EVENT.SELECT_MODULE,
        moduleIndex:index, moduleId:definition.id, attention });
      return true;
    } catch (error) {
      this.helpers.logPluginError("select-module", error, { step:"save-runtime" });
      new Notice("选择模块失败，请稍后重试");
      return false;
    }
  }
  /** @param {number} index @param {AnyRecord} [options] */
  async startModule(index, options={}){
    if (this.plugin.runtime.pendingSettlement && !options.allowPendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复"); return false;
    }
    if (this.plugin.runtime.pendingBreakTransition && !options.allowPendingBreakTransition) {
      new Notice("休息转换待恢复，请先重载插件恢复"); return false;
    }
    if (!options.allowTransition && (this.plugin.runtime.status !== TIMER_STATUS.IDLE || this.plugin.runtime.attention)) {
      new Notice("当前已有计时，请先完成或重置当前模块"); return false;
    }
    const pendingRun = normalizeModuleRun(options.moduleRun);
    const currentIndex = pendingRun
      ? this.plugin.settings.modules.findIndex((/** @type {{id:string}} */ item) => item.id === pendingRun.moduleId) : index;
    const resolvedIndex = currentIndex >= 0 ? currentIndex : index;
    const definition = this.plugin.settings.modules[resolvedIndex];
    const run = normalizeModuleRun(pendingRun?.recoveryOnly ? pendingRun : definition ? createModuleRunSnapshot(
      definition, this.plugin.settings.projectAssignments,
      { enableProjects:this.plugin.settings.enableProjects, runId:pendingRun?.runId, startedAtMs:Date.now() }
    ) : pendingRun);
    if (!run) { new Notice("模块配置无效，请检查名称与时长"); return false; }
    const previousRuntime = this.plugin.runtime;
    this.plugin.ensureDayFreshness(false);
    const effects = this.plugin.applyRuntimeEvent({
      type:RUNTIME_EVENT.START_STAGE,
      stage:run.type === "work" ? TIMER_STAGE.FOCUS : TIMER_STAGE.BREAK,
      durationMs:run.durationMs, now:Date.now(), sessionId:run.runId,
      mode:"modules", moduleIndex:resolvedIndex, moduleRun:run, newSequence:options.newSequence === true
    });
    await this.plugin.saveTransition(previousRuntime);
    this.plugin.runRuntimeEffects(effects);
    this.helpers.playBeep(run.type === "work" ? this.plugin.settings.focusStartSound : this.plugin.settings.breakStartSound,
      this.plugin.settings.enableSound, this.plugin.settings.soundWaveform);
    if (!options.suppressNotify) this.helpers.sysNotify(run.type === "work" ? "开始工作" : "开始休息",
      `${run.name} · ${formatTomatoNumber(run.durationMin)} 分钟`, this.plugin.settings.enableNotify);
    if (run.workspaceCommandId) this.plugin.executeStageCommand(run.workspaceCommandId);
    return true;
  }
  /** @param {boolean} [showNotice] */
  async reset(showNotice=true){
    if (this.plugin.runtime.pendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    const previousRuntime = this.plugin.runtime;
    this.plugin.ensureDayFreshness(false);
    const effects = this.plugin.applyRuntimeEvent({
      type:RUNTIME_EVENT.RESET,
      mode:'modules', selectedModuleId:this.plugin.settings.modules?.[0]?.id || null
    });
    await this.plugin.saveTransition(previousRuntime);
    this.plugin.runRuntimeEffects(effects);
    if (showNotice) new Notice("已重置");
    return true;
  }

  async startPendingStage(){
    const next = this.plugin.runtime.attention;
    if (!next || next.nextStarted) { await this.plugin.stopStrongAlert(); return; }
    if (next.moduleRun && Number.isInteger(next.moduleIndex)) {
      return this.plugin.startModule(Number(next.moduleIndex), { moduleRun:next.moduleRun, allowTransition:true });
    }
    return this.plugin._getLegacyController().startPendingStage();
  }
  /** @param {boolean} [triggerCommand] */
  async togglePause(triggerCommand=false){
    const r = this.plugin.runtime;
    if (!/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(r.status)) return false;
    const previousRuntime = this.plugin.runtime;
    this.plugin.ensureDayFreshness(false);
    const wasPaused = r.status === TIMER_STATUS.PAUSED;
    let effects;
    if (!wasPaused){
      const now = Date.now();
      const elapsedMs = this.plugin.getElapsedMs(now);
      if (elapsedMs >= r.durationMs) {
        await (r.stage === TIMER_STAGE.FOCUS ? this.plugin.settleFocus(false) : this.plugin.settleBreak());
        return false;
      }
      effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.PAUSE, now, elapsedMs });
    } else {
      effects = this.plugin.applyRuntimeEvent({ type:RUNTIME_EVENT.RESUME, now:Date.now() });
    }
    await this.plugin.saveTransition(previousRuntime);
    this.plugin.runRuntimeEffects(effects);
    const current = this.plugin.runtime;
    if (triggerCommand && wasPaused && current.status === TIMER_STATUS.RUNNING) {
      const focusCommandId = current.moduleRun?.workspaceCommandId
        || this.plugin._getLegacyController().resumeFocusCommandId(current);
      if (current.stage === TIMER_STAGE.FOCUS && focusCommandId) this.plugin.executeStageCommand(focusCommandId);
      else if (current.stage === TIMER_STAGE.BREAK) this.plugin._getLegacyController().resumeBreakCommand();
    }
    return true;
  }
}

module.exports = { SequenceController };
