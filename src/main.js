// Pomodoro AIO 源码。项目根目录的 main.js 由 esbuild 生成，请勿直接编辑。
// 变更点：项目下拉在任务上方；项目下拉后有“打开项目”；右上角新增“打开当日日记”按钮；左侧 Ribbon 加图标。

const {
  Plugin, Notice, TFile, getFrontMatterInfo, parseYaml, normalizePath, requestUrl
} = require('obsidian');
const {
  parseHHMMToMinutes,
  formatTomatoNumber,
  normalizeMarkdownPath
} = require("./core/validation");
const {
  getTomatoSum,
  stripBaseName,
  planTaskLineCompletion
} = require("./core/task-lines");
const {
  TIMER_SCHEMA_VERSION,
  TIMER_STATUS,
  TIMER_STAGE,
  plannedTomatoAmount,
  actualTomatoAmount,
  createSessionId,
  getElapsedMs: calculateElapsedMs,
  getRemainingMs: calculateRemainingMs
} = require("./core/timer");
const { RUNTIME_EVENT, RUNTIME_EFFECT, reduceRuntime } = require("./core/state-machine");
const { RuntimeStore } = require("./services/runtime-store");
const { DailyRepository, ProjectRepository } = require("./services/repositories");
const { normalizeCaptureText } = require("./core/quick-capture");
const { PomodoroView } = require("./ui/pomodoro-view");
const { ProjectsView } = require("./ui/projects-view");
const { normalizeModuleDefinition, getNextModule, createModuleRunSnapshot } = require("./core/modules");
const { DEFAULT_SETTINGS, normalizeCurrentSettings } = require("./core/settings");
const { migrateLegacySettings } = require("./legacy/settings-migration");
const { createRuntimeDefaults, normalizeCurrentRuntime, normalizeModuleRun } = require("./core/runtime");
const { normalizeRuntime: normalizeLegacyRuntime } = require("./legacy/runtime-normalization");
const { prepareModuleDraft } = require("./core/module-draft");
const { QuickCaptureModal } = require("./ui/quick-capture-modal");
const { BreakBlackoutController } = require("./ui/break-blackout");
const { NativeBlackoutController } = require("./ui/native-blackout");
const { PomodoroSettingTab } = require("./ui/settings-tab");
const { SequenceController } = require("./controllers/sequence-controller");
const { SettlementCoordinator } = require("./controllers/settlement-coordinator");
const { LegacyRuntimeController } = require("./legacy/runtime-controller");
const { WorkspacesPlusAdapter, workspaceLayoutLabel } = require("./integrations/workspaces-plus");
const { LightingClient } = require("./integrations/lighting-client");
const { createLightingSnapshot } = require("./core/lighting");
/** @typedef {import("../types/contracts").Attention} Attention */
/** @typedef {import("../types/contracts").BreakTransition} BreakTransition */
/** @typedef {import("../types/contracts").ProjectSettlementPlan} ProjectSettlementPlan */
/** @typedef {import("../types/contracts").Runtime} Runtime */
/** @typedef {import("../types/contracts").RuntimeEvent} RuntimeEvent */
/** @typedef {import("../types/contracts").Settings} Settings */
/** @typedef {import("../types/contracts").SettlementJournal} SettlementJournal */
/** @typedef {import("../types/contracts").StageTransition} StageTransition */
/** @typedef {import("../types/contracts").TimerStage} TimerStage */
/** @typedef {Record<string, any>} AnyRecord */

/* ========== 工具函数 ========== */
/** @param {Date} now @param {unknown} startHHMM */
function getLogicalDayKey(now, startHHMM) {
  const startMin = parseHHMMToMinutes(startHHMM) ?? 0;
  const curMin = now.getHours()*60 + now.getMinutes();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(base);
  if (curMin < startMin) d.setDate(d.getDate() - 1);
  const pad2 = (/** @type {number} */ n)=> String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
/** @param {unknown} pattern @param {string} dayKey */
function renderPattern(pattern, dayKey) {
  return String(pattern||"").replace("{{date:YYYY-MM-DD}}", dayKey);
}
/** @param {unknown} value @returns {string | null} */
function tryNormalizeMarkdownPath(value) {
  try { return normalizeMarkdownPath(value, normalizePath); }
  catch (error) { return null; }
}
/** @param {Record<string, any>} [raw] @param {Settings} [fallback] @returns {Settings} */
function normalizeSettings(raw = {}, fallback = DEFAULT_SETTINGS) {
  const input = Number(raw?.schemaVersion) >= TIMER_SCHEMA_VERSION || Array.isArray(raw?.modules)
    ? raw : migrateLegacySettings(raw);
  return normalizeCurrentSettings(input, fallback, normalizePath);
}
/** @param {unknown} raw @param {Settings} settings @param {number} [now] @returns {Runtime} */
function normalizeRuntime(raw, settings, now=Date.now()) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {AnyRecord} */ (raw) : {};
  if (settings.schemaVersion !== TIMER_SCHEMA_VERSION) return normalizeLegacyRuntime(source, settings, now);
  const upgraded = Object.keys(source).length === 0 ? createRuntimeDefaults(settings)
    : Number(source.schemaVersion) >= TIMER_SCHEMA_VERSION
    ? source : normalizeLegacyRuntime(source, settings, now);
  return normalizeCurrentRuntime(upgraded, settings, now);
}
/** @param {string} kind @param {boolean} [enabled] @param {"sine" | "square" | "triangle"} [waveform] @param {boolean} [strong] */
function playBeep(kind, enabled=true, waveform='sine', strong=false) {
  if (!enabled) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    /** @type {Record<string, number[]>} */
    const toneMap = {
      'focus-start': [740, 988],
      'break-start': [660, 523],
      'focus-end': [784, 784, 1047],
      'break-end': [1047, 784, 1047],
      'focus-alert': [784, 1047, 784, 1047],
      'break-alert': [1047, 1047, 784]
    };
    const tones = toneMap[kind] || [520];
    // 波形来源于设置：sine/square/triangle
    tones.forEach((frequency, index) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      const at = ctx.currentTime + index * 0.16;
      osc.type = (waveform === 'square' || waveform === 'triangle') ? waveform : 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(strong ? 0.32 : 0.25, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      osc.connect(gain).connect(ctx.destination); osc.start(at); osc.stop(at + 0.16);
      if (index === tones.length - 1) osc.onended = ()=> ctx.close?.();
    });
  } catch (error) {
    console.warn("Pomodoro AIO 声音提示失败", error);
  }
}
/** @param {string} title @param {string} body @param {boolean} [enabled] */
function sysNotify(title, body, enabled=true) {
  if (!enabled) return;
  try {
    if (!("Notification" in window)) throw new Error("no Notification");
    if (Notification.permission === "granted") { new Notification(title,{body}); return; }
    if (Notification.permission === "default") {
      Notification.requestPermission()
        .then(p=>{ if (p==="granted") new Notification(title,{body}); else new Notice(`${title}｜${body}`); })
        .catch(error=>{ logPluginError("notify", error, { step:"requestPermission" }); new Notice(`${title}｜${body}`); });
      return;
    }
    new Notice(`${title}｜${body}`);
  } catch (error) {
    logPluginError("notify", error, { step:"fallbackNotice" });
    new Notice(`${title}｜${body}`);
  }
}
/** @param {string} operation @param {unknown} error @param {{sessionId?:string|null, stage?:string|null, target?:string|null, step?:string|null}} [context] */
function logPluginError(operation, error, context={}) {
  const details = {
    operation,
    sessionId: context.sessionId || null,
    stage: context.stage || null,
    target: context.target || null,
    step: context.step || null,
    error: String(error instanceof Error ? error.message : error || "unknown error")
  };
  console.error("Pomodoro AIO 操作失败", details);
  return details;
}
/* ========== 后台守护 ========== */
class PomodoroAIO extends Plugin {
  /** @param {...any} args */
  constructor(...args) {
    super(...args);
    this.settings = normalizeSettings();
    this.runtime = createRuntimeDefaults(this.settings);
    /** @type {InstanceType<typeof RuntimeStore> | null} */
    this.runtimeStore = null;
    /** @type {InstanceType<typeof DailyRepository> | null} */
    this.dailyRepository = null;
    /** @type {InstanceType<typeof ProjectRepository> | null} */
    this.projectRepository = null;
    /** @type {InstanceType<typeof WorkspacesPlusAdapter> | null} */
    this.workspacesPlus = null;
    /** @type {InstanceType<typeof LightingClient> | null} */
    this.deviceBridge = null;
    /** @type {number | null} */
    this._lightingHeartbeat = null;
    /** @type {InstanceType<typeof BreakBlackoutController> | InstanceType<typeof NativeBlackoutController> | null} */
    this.breakBlackout = null;
    /** @type {ObsidianElement | null} */
    this.ribbon = null;
    /** @type {ObsidianElement | null} */
    this.ribbonBadge = null;
    /** @type {number | null} */
    this._alertInterval = null;
    /** @type {number | null} */
    this._alertEscalationTimeout = null;
    /** @type {number | null} */
    this._tickTimeout = null;
    /** @type {unknown} */
    this._lastPersistenceError = null;
    this._completionInFlight = false;
    this._runtimeTransitionSaves = 0;
    /** @type {number | null} */
    this._dailyCompletionSyncTimer = null;
    this._dailyCompletionSyncBusy = false;
    /** @type {any} */
    this._dailyCompletionSyncRef = null;
    this._unloading = false;
    this._scheduleTick = () => {};
  }
  async onload() {
    this._lastPersistenceError = null;
    await this.loadSettings();
    this.runtime = normalizeRuntime(await this.loadState(), this.settings);
    if (this.runtime.moduleRun && this.runtime.moduleRun.lighting === undefined) {
      const definition = this.settings.modules.find(item => item.id === this.runtime.moduleRun?.moduleId) || this.runtime.moduleRun;
      this.runtime = { ...this.runtime, moduleRun:{ ...this.runtime.moduleRun, lighting:createLightingSnapshot(definition, this.settings) } };
    }
    this._alertInterval = null;
    this._alertEscalationTimeout = null;
    this._completionInFlight = false;
    this.ribbonBadge = null;
    this._getBreakBlackoutController();
    if (!this.runtime.dayKey) this.runtime = reduceRuntime(this.runtime, {
      type:RUNTIME_EVENT.DAY_ROLLOVER,
      dayKey:this.logicalTodayKey()
    }).runtime;
    await this.saveState({ critical:true });
    this._syncDeviceBridge();
    if (typeof window !== "undefined" && typeof window.setInterval === "function") {
      this._lightingHeartbeat = window.setInterval(() => this._syncDeviceBridge(), 2000);
    }
    void this.refreshLightingLibrary().catch(() => {});
    await this.recoverPendingSettlement();
    await this.recoverPendingBreakTransition();
    try {
      await this.repairFrontmatterQueue();
    } catch (error) {
      logPluginError("startup-frontmatter-repair", error, { step:"drain" });
    }
    if (this.settings.enableProjects) {
      try { await this.drainProjectQueue(); }
      catch (error) { logPluginError("startup-project-retry", error, { step:"drain" }); }
    }
    try {
      await this.syncCompletedTaskSelections();
    } catch (error) {
      logPluginError("startup-task-completion-sync", error, { target:this.todayFilePath(), step:"reconcile" });
    }

    // 视图
    this.registerView(PomodoroView.VIEW_TYPE, (leaf)=> new PomodoroView(leaf, this));
    this.registerView(ProjectsView.VIEW_TYPE, (leaf)=> new ProjectsView(leaf, this));
    this.addCommand({ id: 'open-view', name: '打开番茄视图', callback: (evt)=> this.runUserCommand(()=> this.activateView(), evt) });

    // Ribbon 图标（左侧菜单栏按钮）
    this.ribbon = this.addRibbonIcon('clock', '打开番茄视图', evt => this.runUserCommand(() => this.activateView(), evt));
    if (this.ribbon) {
      this.ribbon.addClass("pomodoro-ribbon");
      this.ribbonBadge = this.ribbon.createDiv({ cls:"pomodoro-ribbon-badge" });
      const originalClick = this.ribbon.onclick?.bind(this.ribbon);
      this.ribbon.onclick = (evt) => {
        this.runUserCommand(() => this.onRibbonClick(), evt);
        if (originalClick) originalClick(evt);
      };
    }

    // 命令
    this.addCommand({ id: 'start-sequence', name: '开始模块循环', callback: (evt)=> this.runUserCommand(()=> this.startSequence(), evt) });
    this.addCommand({ id: 'pause-resume', name: '暂停/继续', callback: (evt)=> this.runUserCommand(()=> this.togglePause(), evt) });
    this.addCommand({ id: 'reset', name: '重置', callback: (evt)=> this.runUserCommand(()=> this.reset(), evt) });
    this.addCommand({ id: 'complete-now', name: '完成本段', callback: (evt)=> this.runUserCommand(()=> this.completeCurrentModule(), evt) });
    this.addCommand({ id: 'complete-task', name: '完成当前任务并勾选日记待办', callback: (evt)=> this.runUserCommand(()=> this.completeTask(), evt) });
    this.addCommand({ id: 'open-today', name: '打开当日日记', callback: (evt)=> this.runUserCommand(()=> this.openToday(), evt) });
    this.addCommand({ id: 'quick-capture', name: '快速记录', callback: (evt)=> this.runUserCommand(()=> this.openQuickCaptureModal(), evt) });
    this._registerDailyTaskCompletionSync();

    // 设置页
    this.addSettingTab(new PomodoroSettingTab(this.app, this, normalizeSettings));

    // 延迟到 layout-ready 再恢复视图，避免干扰工作区恢复
    this.app.workspace.onLayoutReady(() => {
      if (!this.runtime.viewWasOpen) return;
      const leaves = this.app.workspace.getLeavesOfType(PomodoroView.VIEW_TYPE);
      if (!leaves.length) this.runAutoAction(()=> this.activateView({ source:"auto" }));
    });

    // 对齐整秒的调度器
    this._tickTimeout = null;
    this._unloading = false;
    this._scheduleTick = () => {
      if (this._unloading) return;
      const now = Date.now();
      const base = this.runtime.startedAtMs || now;
      const delay = Math.max(50, 1000 - ((now - base) % 1000));
      this._tickTimeout = window.setTimeout(() => {
        if (this._unloading) return;
        this.tick().catch(error => logPluginError("tick", error, {
          sessionId: this.runtime?.sessionId,
          stage: this.runtime?.stage,
          step: "schedule"
        }));
        this._scheduleTick();
      }, delay);
    };
    this._scheduleTick();
    this.applyStrongAlertStateFromRuntime();
    this.updateRibbonVisuals();
    this.syncBreakBlackout();
  }
  async onunload(){
    this._unloading = true;
    if (this._lightingHeartbeat !== null) window.clearInterval(this._lightingHeartbeat);
    this._lightingHeartbeat = null;
    if (this._dailyCompletionSyncTimer) window.clearTimeout(this._dailyCompletionSyncTimer);
    this._dailyCompletionSyncTimer = null;
    if (this._dailyCompletionSyncRef) this.app?.vault?.offref?.(this._dailyCompletionSyncRef);
    this._dailyCompletionSyncRef = null;
    this.breakBlackout?.destroy();
    this.stopPersistentAlertSound();
    if (this._tickTimeout) window.clearTimeout(this._tickTimeout);
    await this.deviceBridge?.dispose?.();
    await this.flushPendingSaves();
  }

  _getRuntimeStore(){
    if (this.runtimeStore) return this.runtimeStore;
    this.runtimeStore = new RuntimeStore({
      readRuntime: () => this.app.loadLocalStorage("pomodoro-aio-runtime"),
      writeRuntime: snapshot => this.app.saveLocalStorage("pomodoro-aio-runtime", snapshot),
      readSettings: () => this.loadData(),
      writeSettings: snapshot => this.saveData(snapshot),
      onError: (error, context={}) => {
        this._lastPersistenceError = error;
        logPluginError(context.operation || "persistence", error, {
          ...context,
          sessionId: context.sessionId || this.runtime?.sessionId,
          stage: context.stage || this.runtime?.stage,
          step: "write"
        });
        new Notice("番茄钟状态保存失败，请重试当前操作");
      }
    });
    return this.runtimeStore;
  }
  async loadState(){ return this._getRuntimeStore().loadRuntime(); }
  async flushPendingSaves(){ await this._getRuntimeStore().flush(); }
  /** @param {{critical?:boolean}} [options] */
  async saveState(options={}){
    return this._getRuntimeStore().saveRuntime(this.runtime, options);
  }
  /** @param {Runtime} previousRuntime */
  async saveTransition(previousRuntime){
    this._runtimeTransitionSaves += 1;
    try {
      await this.saveState({ critical:true });
    } catch (error) {
      this.runtime = previousRuntime;
      this.applyStrongAlertStateFromRuntime();
      this.broadcast();
      this._resyncTick();
      throw error;
    } finally {
      this._runtimeTransitionSaves -= 1;
    }
    this._syncDeviceBridge();
  }
  _getDeviceBridge(){
    if (this.deviceBridge) return this.deviceBridge;
    this.deviceBridge = new LightingClient({
      requestFn:typeof requestUrl === "function" ? async (/** @type {string} */ url, /** @type {AnyRecord} */ init) => {
        const response = await requestUrl({ url, method:init.method, headers:init.headers, body:init.body, throw:false });
        return { ok:response.status >= 200 && response.status < 300, status:response.status, json:async () => response.json };
      } : null,
      onStatus:() => { if (!this._unloading) this.broadcast(); }
    });
    this.deviceBridge.configure(this.settings);
    return this.deviceBridge;
  }
  _syncDeviceBridge(){
    if (this._unloading || this._runtimeTransitionSaves > 0 || this._completionInFlight) return;
    try {
      const bridge = this._getDeviceBridge();
      bridge.configure?.(this.settings);
      bridge.syncFromRuntime(this.runtime, { elapsedMs:this.getElapsedMs() })?.catch?.(() => {});
    } catch (error) {
      console.debug("Pomodoro AIO Device Bridge sync error", error);
    }
  }
  /** @param {RuntimeEvent} event */
  applyRuntimeEvent(event){
    const transition = this.runtime.mode === "modules"
      ? reduceRuntime(this.runtime, event)
      : this._getLegacyController().applyRuntimeEvent(event);
    this.runtime = transition.runtime;
    return transition.effects;
  }
  /** @param {string[]} [effects] */
  runRuntimeEffects(effects=[]){
    for (const effect of effects) {
      if (effect === RUNTIME_EFFECT.ALERT_START) {
        this.updateRibbonAlertUI(true);
        this.startPersistentAlertSound();
      } else if (effect === RUNTIME_EFFECT.ALERT_STOP) {
        this.stopPersistentAlertSound();
        this.updateRibbonAlertUI(false);
        this.updateRibbonBadge();
      } else if (effect === RUNTIME_EFFECT.BROADCAST) this.broadcast();
      else if (effect === RUNTIME_EFFECT.RESYNC) this._resyncTick();
    }
  }
  /** @param {RuntimeEvent} event */
  async commitRuntimeEvent(event){
    const previousRuntime = this.runtime;
    const effects = this.applyRuntimeEvent(event);
    await this.saveTransition(previousRuntime);
    this.runRuntimeEffects(effects);
  }
  async loadSettings(){
    const data = await this._getRuntimeStore().loadSettings();
    const record = data && typeof data === "object" && !Array.isArray(data) ? /** @type {AnyRecord} */ (data) : {};
    this.settings = normalizeSettings(record);
    if (!Number.isFinite(Number(record.schemaVersion)) || Number(record.schemaVersion) < TIMER_SCHEMA_VERSION) await this.saveSettings();
    return this.settings;
  }
  async saveSettings(){
    await this._getRuntimeStore().saveSettings(this.settings);
    if (!this._unloading) this._syncDeviceBridge();
  }
  async refreshLightingLibrary(){
    const bridge = this._getDeviceBridge();
    bridge.configure(this.settings);
    const result = await bridge.refreshLibrary();
    const previousPrograms = this.settings.lightingPrograms;
    this.settings.lightingPrograms = result.programs;
    try { await this.saveSettings(); }
    catch (error) { this.settings.lightingPrograms = previousPrograms; throw error; }
    this.broadcast();
    return result;
  }
  /** @param {unknown} input */
  async saveLightProgram(input){
    const bridge = this._getDeviceBridge(); bridge.configure(this.settings);
    const saved = await bridge.saveProgram(input);
    try { await this.refreshLightingLibrary(); }
    catch { throw new Error("方案已在服务端保存，本地同步失败；请刷新方案库后继续编辑"); }
    return saved;
  }
  /** @param {AnyRecord} program */
  async deleteLightProgram(program){
    const referenced = this.settings.modules.some(module => module.lightProgramId === program.id)
      || this.settings.lightingDefaultWorkId === program.id || this.settings.lightingDefaultRestId === program.id;
    if (referenced) throw new Error("此方案仍被任务或默认灯光使用，请先更换绑定");
    const bridge = this._getDeviceBridge(); bridge.configure(this.settings);
    await bridge.deleteProgram(program);
    await this.refreshLightingLibrary();
  }
  /** @param {unknown} program */
  async previewLightProgram(program){
    if (this.runtime.status !== TIMER_STATUS.IDLE || this.runtime.attention) throw new Error("请先结束当前任务，再预览灯光");
    const bridge = this._getDeviceBridge(); bridge.configure(this.settings);
    return bridge.preview(program);
  }

  /* ====== 环境守护 ====== */
  respectGuardsEnabled(){ return this.settings?.respectModalInputFocus !== false; }
  /** @param {Element | null | undefined} el */
  isElementVisible(el){
    if (!el) return false;
    try {
      const style = window.getComputedStyle?.(el);
      if (style) {
        if (style.display === "none") return false;
        if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      }
      if (el instanceof HTMLElement && el.offsetParent === null && style?.position !== "fixed") return false;
      return true;
    } catch { return true; }
  }
  /** @param {unknown} target */
  isTextInputTarget(target){
    const el = target instanceof HTMLElement ? target : null;
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.closest?.("input, textarea, select")) return true;
    if (el.isContentEditable || el.getAttribute?.("contenteditable") === "true") return true;
    if (el.closest?.("[contenteditable='true']")) return true;
    if (el.closest?.(".cm-editor")) return true;
    if (el.closest?.(".markdown-source-view") || el.closest?.(".markdown-preview-view")) return true;
    return false;
  }
  hasBlockingOverlay(){
    if (!this.respectGuardsEnabled()) return false;
    try {
      const root = document?.body || document;
      const selectors = [
        ".modal", ".modal-container", ".modal-bg",
        ".prompt", ".suggestion-container", ".popover",
        ".quick-switcher", ".command-palette", ".mod-command-palette",
        ".pmd-blackout-overlay"
      ];
      const nodes = root?.querySelectorAll?.(selectors.join(", ")) || [];
      for (const el of nodes) {
        if (this.isElementVisible(el)) return true;
      }
      return false;
    } catch { return false; }
  }
  /** @param {Event | null | undefined} evt @param {{allowInPluginInput?:boolean, allowInText?:boolean}} [opts] */
  shouldBlockHotkeys(evt, opts={}){
    if (!this.respectGuardsEnabled()) return false;
    if (evt?.defaultPrevented) return true;
    if (this.hasBlockingOverlay()) return true;
    const allowInPluginInput = !!opts.allowInPluginInput;
    const allowInText = !!opts.allowInText;
    let target = evt?.target;
    if (!target){
      try { target = document?.activeElement; } catch (error) { console.debug("Pomodoro AIO 无法读取当前输入目标", error); }
    }
    if (!allowInPluginInput && !allowInText && target && this.isTextInputTarget(target)) return true;
    return false;
  }
  /** @param {{source?:string}} [opts] */
  shouldBlockFocusLayoutSideEffects(opts={}){
    if (!this.respectGuardsEnabled()) return false;
    const source = opts.source || "auto";
    if (this.hasBlockingOverlay()) return true;
    if (source === "auto") {
      let active = null;
      try { active = document.activeElement; } catch (error) { console.debug("Pomodoro AIO 无法读取当前焦点", error); }
      if (active && this.isTextInputTarget(active)) return true;
    }
    return false;
  }
  /** @param {()=>any} fn @param {Event | null | undefined} evt */
  runUserCommand(fn, evt){
    if (this.shouldBlockHotkeys(evt, { allowInText:true })) return false;
    if (this.shouldBlockFocusLayoutSideEffects({ source:"user" })) return false;
    try {
      const result = fn();
      result?.catch?.((/** @type {unknown} */ error) => logPluginError("user-command", error, { step:"execute" }));
    } catch(err){ logPluginError("user-command", err, { step:"execute" }); }
    return true;
  }
  /** @param {()=>any} fn */
  runAutoAction(fn){
    if (this.shouldBlockFocusLayoutSideEffects({ source:"auto" })) return false;
    try {
      const result = fn();
      result?.catch?.((/** @type {unknown} */ error) => logPluginError("auto-action", error, { step:"execute" }));
    } catch(err){ logPluginError("auto-action", err, { step:"execute" }); }
    return true;
  }

  /* ====== 视图与广播 ====== */
  /** @param {{source?:string, leaf?:any}} [opts] */
  async activateView(opts={}) {
    const source = opts.source || "user";
    if (this.shouldBlockFocusLayoutSideEffects({ source })) return;
    if (opts.leaf) {
      await opts.leaf.setViewState({ type: PomodoroView.VIEW_TYPE, active: true });
      await this.app.workspace.revealLeaf(opts.leaf);
      return;
    }
    const leaves = this.app.workspace.getLeavesOfType(PomodoroView.VIEW_TYPE);
    if (leaves.length) { await this.app.workspace.revealLeaf(leaves[0]); return; }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: PomodoroView.VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
  /** @param {any} [sourceLeaf] */
  async activateProjectsView(sourceLeaf){
    if (!this.settings.enableProjects) return false;
    if (this.shouldBlockFocusLayoutSideEffects({ source:"user" })) return false;
    if (sourceLeaf) {
      await sourceLeaf.setViewState({ type: ProjectsView.VIEW_TYPE, active: true });
      await this.app.workspace.revealLeaf(sourceLeaf);
      return true;
    }
    const leaves = this.app.workspace.getLeavesOfType(ProjectsView.VIEW_TYPE);
    if (leaves.length) { await this.app.workspace.revealLeaf(leaves[0]); return true; }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type:ProjectsView.VIEW_TYPE, active:true });
    await this.app.workspace.revealLeaf(leaf);
    return true;
  }
  broadcast() {
    const snap = this.snapshot();
    this.updateRibbonVisuals(snap.runtime);
    this.syncBreakBlackout(snap);
    this.app.workspace.trigger('pomodoro:aio-state', snap);
  }
  _getBreakBlackoutController(){
    if (this.breakBlackout) return this.breakBlackout;
    if (typeof document === "undefined" || !document.body) return null;
    const basePath = this.app?.vault?.adapter?.getBasePath?.();
    const pluginDir = this.manifest?.dir;
    if (process.platform === "darwin" && basePath && pluginDir) {
      const path = require("node:path");
      const binaryPath = path.resolve(basePath, pluginDir, "bin", "pomodoro-blackout");
      this.breakBlackout = new NativeBlackoutController({
        document,
        binaryPath,
        onUnavailable: reason => new Notice(`原生黑屏不可用，已退回 Obsidian 窗口遮罩：${reason}`)
      });
      return this.breakBlackout;
    }
    this.breakBlackout = new BreakBlackoutController({ document });
    return this.breakBlackout;
  }
  /** @param {{settings:Settings, runtime:Runtime & {leftSec?:number}} | null} [snapshot] */
  syncBreakBlackout(snapshot=null){
    const controller = this._getBreakBlackoutController();
    if (!controller) return false;
    const snap = snapshot || this.snapshot();
    return controller.sync(snap.runtime, snap.settings, snap.runtime.leftSec ?? this.getLeftSec());
  }
  snapshot(){
    const leftMs = this.getLeftMs();
    const pendingId = this.runtime.attention?.moduleRun?.moduleId;
    const movedIndex = pendingId ? this.settings.modules.findIndex(item => item.id === pendingId) : -1;
    const selectedIndex = this.settings.modules.findIndex(item => item.id === this.runtime.selectedModuleId);
    const position = movedIndex >= 0 ? movedIndex
      : this.runtime.status === TIMER_STATUS.IDLE && selectedIndex >= 0 ? selectedIndex
        : this.runtime.attention?.moduleIndex ?? this.runtime.currentModuleIndex ?? 0;
    const next = getNextModule(this.settings.modules || [], position, this.runtime.completedLoopCount || 0, this.settings);
    const nextModule = this.runtime.status === TIMER_STATUS.IDLE
      ? this.settings.modules?.[position] || null
      : next.nextIndex !== null ? this.settings.modules?.[next.nextIndex] || null : null;
    return {
      settings: this.settings,
      lightingStatus:this.deviceBridge?.status,
      runtime: Object.assign({}, this.runtime, { leftMs, leftSec: Math.ceil(leftMs / 1000), nextModule })
    };
  }
  /** @param {(Runtime & {leftSec?:number}) | null | undefined} [runtime] */
  updateRibbonVisuals(runtime){
    if (!this.ribbon) return;
    const r = runtime || Object.assign({}, this.runtime, { leftSec: this.getLeftSec() });
    this.updateRibbonBadge(r);
    this.updateRibbonAlertUI(!!r.attention);
  }
  /** @param {(Runtime & {leftSec?:number}) | null | undefined} [runtime] */
  updateRibbonBadge(runtime){
    if (!this.ribbonBadge || !this.ribbon) return;
    const status = runtime?.status || this.runtime.status;
    const sec = runtime?.leftSec ?? this.getLeftSec();
    const show = status !== TIMER_STATUS.IDLE && sec > 0;
    if (show) {
      const minutes = Math.max(0, Math.ceil(sec / 60));
      this.ribbonBadge.setText(String(minutes));
      this.ribbon.addClass("pomodoro-ribbon-has-badge");
    } else {
      this.ribbonBadge.setText("");
      this.ribbon.removeClass("pomodoro-ribbon-has-badge");
    }
  }
  /** @param {boolean} active */
  updateRibbonAlertUI(active){
    if (!this.ribbon) return;
    if (active) this.ribbon.addClass("pomodoro-ribbon-alert");
    else this.ribbon.removeClass("pomodoro-ribbon-alert");
  }
  startPersistentAlertSound(){
    if (!this.settings.enableSound || !this.settings.persistentAlertSound) return;
    if (this._alertInterval || this._alertEscalationTimeout) return;
    const alertKind = ()=> this.runtime.attention?.type === TIMER_STAGE.FOCUS ? this.settings.breakAlertSound : this.settings.focusAlertSound;
    const delay = Math.max(1, Number(this.settings.strongAlertDelaySec) || 30) * 1000;
    const interval = Math.max(1, Number(this.settings.strongAlertIntervalSec) || 60) * 1000;
    this._alertEscalationTimeout = window.setTimeout(()=> {
      this._alertEscalationTimeout = null;
      playBeep(alertKind(), true, this.settings.soundWaveform, true);
      this._alertInterval = window.setInterval(()=> playBeep(alertKind(), true, this.settings.soundWaveform, true), interval);
    }, delay);
  }
  stopPersistentAlertSound(){
    if (this._alertEscalationTimeout) {
      window.clearTimeout(this._alertEscalationTimeout);
      this._alertEscalationTimeout = null;
    }
    if (this._alertInterval) {
      window.clearInterval(this._alertInterval);
      this._alertInterval = null;
    }
  }
  applyStrongAlertStateFromRuntime(){
    if (!this.runtime.attention) {
      this.updateRibbonAlertUI(false);
      this.stopPersistentAlertSound();
      return;
    }
    this.updateRibbonAlertUI(true);
    this.startPersistentAlertSound();
  }
  async onRibbonClick(){
    if (!this.runtime.attention) return;
    if (this.runtime.attention.moduleRun) return this.startPendingStage();
    if (!this.settings.ribbonClickAutoNext || this.runtime.attention.nextStarted) {
      await this.stopStrongAlert();
      return;
    }
    await this.startPendingStage();
  }
  startPendingStage(){ return this._getSequenceController().startPendingStage(); }
  /** @param {{type?:string,autoStarted?:boolean,durationMs?:number,moduleIndex?:number,moduleRun?:import("../types/contracts").ModuleRun|null}} nextPhase */
  async beginStrongAlert(nextPhase){
    if (!nextPhase?.moduleRun) return this._getLegacyController().beginStrongAlert(nextPhase);
    const run = normalizeModuleRun(nextPhase.moduleRun);
    if (!run) return;
    const attention = {
      type:run.type === "work" ? TIMER_STAGE.FOCUS : TIMER_STAGE.BREAK,
      nextStarted:nextPhase.autoStarted === true,
      durationMs:Math.max(1, Number(nextPhase.durationMs) || run.durationMs),
      moduleIndex:Number.isInteger(nextPhase.moduleIndex) ? nextPhase.moduleIndex : 0,
      moduleRun:run
    };
    await this.commitRuntimeEvent({ type:RUNTIME_EVENT.SET_ATTENTION, attention });
  }
  async stopStrongAlert(){
    if (!this.runtime.attention) {
      this.stopPersistentAlertSound();
      this.updateRibbonAlertUI(false);
      return;
    }
    await this.commitRuntimeEvent({ type:RUNTIME_EVENT.CLEAR_ATTENTION });
  }
  /** @param {unknown} tomatoAmount @param {string} next */
  focusCompletionBody(tomatoAmount, next){
    if (!this.runtime.moduleRun) return this._getLegacyController().focusCompletionBody(tomatoAmount, next);
    return `完成：${this.runtime.moduleRun.name} · +${formatTomatoNumber(tomatoAmount)}🍅\n下一步：${next}`;
  }
  /** @param {unknown} commandId */
  executeStageCommand(commandId){
    const id = String(commandId||"").trim();
    if (!id) return false;
    if (this.isWorkspaceLayoutActive(id)) return true;
    try {
      const executed = this.app?.commands?.executeCommandById?.(id);
      if (executed === false) new Notice("附带命令不可用，请重新选择");
      return executed !== false;
    } catch (err) {
      logPluginError("stage-command", err, { target: id, step:"execute" });
      new Notice("附带命令执行失败，请重新选择");
      return false;
    }
  }
  getWorkspaceLayoutCommands(){
    return this._getWorkspacesPlus().getLayoutCommands();
  }
  /** @param {unknown} commandId */
  isWorkspaceLayoutActive(commandId){
    return this._getWorkspacesPlus().isLayoutActive(commandId);
  }

  _getLegacyController(){
    if (!this.legacyController) this.legacyController = new LegacyRuntimeController(this, { playBeep, sysNotify, logPluginError, normalizeSettings, tryNormalizeMarkdownPath });
    return this.legacyController;
  }
  _getSettlementCoordinator(){
    if (!this.settlementCoordinator) this.settlementCoordinator = new SettlementCoordinator(this, { playBeep, sysNotify, logPluginError });
    return this.settlementCoordinator;
  }
  _getSequenceController(){
    if (!this.sequenceController) this.sequenceController = new SequenceController(this, { playBeep, sysNotify, logPluginError });
    return this.sequenceController;
  }

  /* ====== 计时控制 ====== */
  getLeftMs(){
    return calculateRemainingMs(this.runtime, this.settings);
  }
  /** @param {number} [at] */
  getElapsedMs(at=Date.now()){
    return calculateElapsedMs(this.runtime, at);
  }
  getLeftSec(){
    return Math.ceil(this.getLeftMs() / 1000);
  }
  /** @param {boolean} [persist] */
  ensureDayFreshness(persist=true){
    const cur = this.logicalTodayKey();
    if (this.runtime.dayKey !== cur){
      const effects = this.applyRuntimeEvent({ type:RUNTIME_EVENT.DAY_ROLLOVER, dayKey:cur });
      if (persist) {
        this.saveState();
        this.runRuntimeEffects(effects);
      }
    }
  }
  /** @param {{modules?:import("../types/contracts").ModuleDefinition[], restPresets?:string[], projectAssignments?:Record<string,string>}} patch */
  async persistModuleSettings(patch){
    const previousModules = this.settings.modules;
    const previousRestPresets = this.settings.restPresets;
    const previousAssignments = this.settings.projectAssignments;
    Object.assign(this.settings, patch);
    try {
      await this.saveSettings();
      this.broadcast();
    } catch (error) {
      this.settings.modules = previousModules;
      this.settings.restPresets = previousRestPresets;
      this.settings.projectAssignments = previousAssignments;
      this.broadcast();
      throw error;
    }
  }
  /** @param {{baseSignature:string,modules:Record<string, any>[],restPresetsText:string}} draft */
  async saveModuleDraft(draft){
    const patch = prepareModuleDraft(draft, this.settings);
    const retainedIds = new Set(patch.modules.filter(module => module.type === "work").map(module => module.id));
    const projectAssignments = Object.fromEntries(Object.entries(this.settings.projectAssignments)
      .filter(([id]) => retainedIds.has(id)));
    await this.persistModuleSettings({ ...patch, projectAssignments });
    return true;
  }
  /** @param {"work" | "rest"} type */
  async addModule(type){
    const module = normalizeModuleDefinition({
      id:createSessionId(), type, name:type === "rest" ? "休息" : "工作",
      durationMin:type === "rest" ? 5 : 25, blackout:false, workspaceCommandId:""
    });
    await this.persistModuleSettings({ modules:[...this.settings.modules, module] });
    return module;
  }
  /** @param {string} id @param {Partial<import("../types/contracts").ModuleDefinition>} patch */
  async updateModule(id, patch){
    const index = this.settings.modules.findIndex(item => item.id === id);
    if (index < 0) return false;
    const previous = this.settings.modules[index];
    const next = normalizeModuleDefinition({ ...previous, ...patch, id:previous.id, type:previous.type });
    await this.persistModuleSettings({ modules:this.settings.modules.map(item => item.id === id ? next : item) });
    return true;
  }
  /** @param {string} id */
  async removeModule(id){
    if (!this.settings.modules.some(item => item.id === id)) return false;
    const modules = this.settings.modules.filter(item => item.id !== id);
    const assignments = { ...this.settings.projectAssignments };
    delete assignments[id];
    await this.persistModuleSettings({ modules, projectAssignments:assignments });
    return true;
  }
  /** @param {string} id @param {number} toIndex */
  async moveModule(id, toIndex){
    const list = [...this.settings.modules];
    const from = list.findIndex(item => item.id === id);
    if (from < 0 || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= list.length) return false;
    const [module] = list.splice(from, 1);
    list.splice(toIndex, 0, module);
    await this.persistModuleSettings({ modules:list });
    return true;
  }
  /** @param {string} id @param {unknown} path */
  async setModuleProject(id, path){
    const module = this.settings.modules.find(item => item.id === id && item.type === "work");
    if (!module) return false;
    const rawPath = String(path || "").trim();
    const projectPath = rawPath ? tryNormalizeMarkdownPath(rawPath) : "";
    if (rawPath && !projectPath) { new Notice("项目路径无效"); return false; }
    await this.persistModuleSettings({ projectAssignments:{ ...this.settings.projectAssignments, [id]:projectPath || "" } });
    return true;
  }
  /** @param {number | AnyRecord} [indexOrOptions] @param {AnyRecord} [options] */
  startSequence(indexOrOptions, options={}) { return this._getSequenceController().startSequence(indexOrOptions, options); }
  /** @param {number} index */
  selectModule(index) { return this._getSequenceController().selectModule(index); }
  /** @param {number} index @param {AnyRecord} [options] */
  startModule(index, options={}) { return this._getSequenceController().startModule(index, options); }
  /** @param {any} [options] */
  startFocus(options){ return this._getLegacyController().startFocus(options); }
  /** @param {number} [slot] @param {any} [options] */
  startCycle(slot, options={}){ return this._getLegacyController().startCycle(slot, options); }
  /** @param {boolean} [isLong] @param {any} [options] */
  startBreak(isLong=false, options){ return this._getLegacyController().startBreak(isLong, options); }
  /** @param {boolean} [triggerCommand] */
  togglePause(triggerCommand=false){ return this._getSequenceController().togglePause(triggerCommand); }
  /** @param {boolean} [showNotice] */
  reset(showNotice=true) { return this._getSequenceController().reset(showNotice); }

  /* ====== 到点/补记 ====== */
  async tick(){
    this.ensureDayFreshness();
    // 每次对齐触发时先广播，保证视图秒表顺滑
    this.broadcast();
    if (this._completionInFlight) return;
    this._syncDeviceBridge();

    const r = this.runtime;
    if (r.status !== TIMER_STATUS.RUNNING || !r.startedAtMs || !r.durationMs) return;

    const leftMs = this.getLeftMs();
    if (leftMs > 0) return;
    if (this.breakBlackout?.isFinishing()) return;

    if (r.stage === TIMER_STAGE.FOCUS) await this.settleFocus(false);
    else if (r.stage === TIMER_STAGE.BREAK) await this.settleBreak();
  }
  async forceCompleteFocusOnce(){
    this.ensureDayFreshness();
    if (!/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(this.runtime.status) || this.runtime.stage !== TIMER_STAGE.FOCUS) {
      new Notice("当前不在专注阶段"); return;
    }
    if (this._completionInFlight) { new Notice("正在结算当前专注"); return; }
    if (this.getElapsedMs() <= 0) {
      if (this.runtime.moduleRun) return this.completeEmptyWorkModule();
      new Notice("尚未产生有效专注时长"); return;
    }
    await this.settleFocus(true);
  }

  completeEmptyWorkModule(){ return this._getSettlementCoordinator().completeEmptyWorkModule(); }

  async completeCurrentModule(){
    if (this.runtime.moduleRun?.type === "rest"
      && /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(this.runtime.status)) return this.settleBreak(true);
    if (this.runtime.moduleRun?.type === "work") return this.forceCompleteFocusOnce();
    new Notice("当前没有可完成的模块");
    return false;
  }

  /** @param {{moduleId?:string} | undefined} [options] */
  async completeTask(options){
    const selectedId = (typeof options === "object" ? options?.moduleId : null) || this.runtime.moduleRun?.moduleId;
    const module = this.settings.modules.find(item => item.id === selectedId && item.type === "work");
    if (!module) { new Notice("请先选择要完成的工作模块"); return false; }
    const activeRun = this.runtime.moduleRun;
    const task = activeRun && activeRun.moduleId === selectedId ? activeRun.name : module.name;
    try {
      const daily = this._getDailyRepository();
      const current = await daily.readPath(this.todayFilePath());
      if (!daily.isFile(current.file)) throw new Error("找不到当天任务文件");
      planTaskLineCompletion(current.text, task);
      if (this.runtime.moduleRun?.moduleId === selectedId
        && /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(this.runtime.status)) {
        if (this.getElapsedMs() > 0) await this.settleFocus(true);
        else await this.completeEmptyWorkModule();
        if (this.runtime.pendingSettlement || this.runtime.status === TIMER_STATUS.FAILED) return false;
      }
      await daily.completeTask({ taskName:task, path:this.todayFilePath() });
      await this.clearCompletedModuleTask(module.id, task);
      new Notice("事情已完成，日记待办已勾选");
      return true;
    } catch (error) {
      logPluginError("complete-module-task", error, { target:this.todayFilePath(), step:"daily-checkbox" });
      new Notice("完成事情失败，请检查当日日记");
      return false;
    }
  }

  /** @param {string} id @param {string} [completedTask] */
  async clearCompletedModuleTask(id, completedTask){
    const module = this.settings.modules.find(item => item.id === id && item.type === "work");
    if (!module) return false;
    // Completing the running snapshot must not erase a different future task.
    if (completedTask !== undefined && module.name !== completedTask) return false;
    const modules = this.settings.modules.map(item => item.id === id
      ? { ...item, name:"工作", workspaceCommandId:"", blackout:false, lightProgramId:"" } : item);
    const assignments = { ...this.settings.projectAssignments };
    delete assignments[id];
    await this.persistModuleSettings({ modules, projectAssignments:assignments });
    if (this.runtime.attention?.moduleRun?.moduleId === id && Number.isInteger(this.runtime.attention.moduleIndex)) {
      const index = this.runtime.attention.moduleIndex;
      const replacement = createModuleRunSnapshot(this.settings.modules[Number(index)], {}, { enableProjects:false, settings:this.settings });
      await this.beginStrongAlert({
        type:TIMER_STAGE.FOCUS, autoStarted:false, durationMs:replacement.durationMs,
        moduleIndex:Number(index), moduleRun:replacement
      });
    }
    this.broadcast();
    return true;
  }

  /** @param {string} task @param {0|1|null} slot */
  isActiveFocusTask(task, slot){ return this._getLegacyController().isActiveFocusTask(task, slot); }
  /** @param {string} task @param {0|1|null} slot */
  settleOrEndActiveTaskForCompletion(task, slot){ return this._getLegacyController().settleOrEndActiveTaskForCompletion(task, slot); }
  /** @param {string} task @param {0|1|null} slot */
  clearCompletedTaskSelection(task, slot){ return this._getLegacyController().clearCompletedTaskSelection(task, slot); }

  /** @param {boolean} [manual] */
  settleFocus(manual=false){ return this._getSettlementCoordinator().settleFocus(manual); }
  /** @param {Runtime} runtime @param {"work"|"rest"} completedType */
  buildModuleTransition(runtime, completedType){ return this._getSettlementCoordinator().buildModuleTransition(runtime, completedType); }
  /** @param {number} amount @param {StageTransition} transition @param {number} sessionCountAfter @param {boolean} [manual] */
  prepareSettlement(amount, transition, sessionCountAfter, manual=false){ return this._getSettlementCoordinator().prepareSettlement(amount, transition, sessionCountAfter, manual); }
  /** @param {number} amount */
  prepareProjectSettlement(amount){ return this._getSettlementCoordinator().prepareProjectSettlement(amount); }
  /** @param {SettlementJournal} journal */
  applyDailySettlement(journal){ return this._getSettlementCoordinator().applyDailySettlement(journal); }
  /** @param {ProjectSettlementPlan} plan */
  applyProjectPlan(plan){ return this._getSettlementCoordinator().applyProjectPlan(plan); }
  /** @param {SettlementJournal} journal */
  applyProjectSettlement(journal){ return this._getSettlementCoordinator().applyProjectSettlement(journal); }
  /** @param {AnyRecord} item */
  upsertProjectRetry(item){ return this._getSettlementCoordinator().upsertProjectRetry(item); }
  /** @param {unknown} sessionId @param {unknown} path */
  removeProjectRetry(sessionId, path){ return this._getSettlementCoordinator().removeProjectRetry(sessionId, path); }
  /** @param {ProjectSettlementPlan} plan */
  notifyProjectUpdated(plan){ return this._getSettlementCoordinator().notifyProjectUpdated(plan); }
  /** @param {AnyRecord[]} queue @param {number} startIndex @param {AnyRecord} predecessor */
  rebaseProjectSuccessors(queue, startIndex, predecessor){ return this._getSettlementCoordinator().rebaseProjectSuccessors(queue, startIndex, predecessor); }
  /** @param {AnyRecord} item */
  upsertFrontmatterRepair(item){ return this._getSettlementCoordinator().upsertFrontmatterRepair(item); }
  /** @param {unknown} path @param {unknown} key @param {unknown} sessionId */
  removeFrontmatterRepair(path, key, sessionId){ return this._getSettlementCoordinator().removeFrontmatterRepair(path, key, sessionId); }
  repairFrontmatterQueue(){ return this._getSettlementCoordinator().repairFrontmatterQueue(); }
  drainProjectQueue(){ return this._getSettlementCoordinator().drainProjectQueue(); }
  /** @param {SettlementJournal} journal */
  finalizeFocusSettlement(journal){ return this._getSettlementCoordinator().finalizeFocusSettlement(journal); }
  resumePendingSettlement(){ return this._getSettlementCoordinator().resumePendingSettlement(); }
  recoverPendingSettlement(){ return this._getSettlementCoordinator().recoverPendingSettlement(); }
  /** @param {BreakTransition} transition */
  advanceBreakTransition(transition){ return this._getSettlementCoordinator().advanceBreakTransition(transition); }
  recoverPendingBreakTransition(){ return this._getSettlementCoordinator().recoverPendingBreakTransition(); }
  /** @param {boolean} [manual] */
  settleBreak(manual=false){ return this._getSettlementCoordinator().settleBreak(manual); }
  /** @param {unknown} error @param {AnyRecord} [context] */
  markSettlementFailed(error, context={}){ return this._getSettlementCoordinator().markSettlementFailed(error, context); }
  _resyncTick(){
    if (this._tickTimeout) window.clearTimeout(this._tickTimeout);
    this._scheduleTick && this._scheduleTick();
  }

  /* ====== 文件相关 ====== */
  logicalTodayKey(now=new Date()){ return getLogicalDayKey(now, this.settings.dayStartHHMM || "00:00"); }
  todayFilePath(){
    return normalizeMarkdownPath(
      renderPattern(this.settings.fallbackPattern || "Daily/{{date:YYYY-MM-DD}}.md", this.logicalTodayKey()),
      normalizePath
    );
  }
  quickCaptureFilePath(){
    if (!this.settings.capturePathPattern) return this.todayFilePath();
    const pattern = this.settings.capturePathPattern;
    return normalizeMarkdownPath(renderPattern(pattern, this.logicalTodayKey()), normalizePath);
  }
  _getDailyRepository(){
    if (this.dailyRepository) return this.dailyRepository;
    this.dailyRepository = new DailyRepository({
      vault: this.app.vault,
      fileManager: this.app.fileManager,
      isFile: file => file instanceof TFile,
      todayPath: () => this.todayFilePath(),
      allowCreateDaily: () => this.settings.allowCreateDaily
    });
    return this.dailyRepository;
  }
  _getProjectRepository(){
    if (this.projectRepository) return this.projectRepository;
    this.projectRepository = new ProjectRepository({
      vault: this.app.vault,
      fileManager: this.app.fileManager,
      metadataCache: this.app.metadataCache,
      isFile: file => file instanceof TFile,
      readFrontmatter: async file => {
        const info = getFrontMatterInfo(await this.app.vault.read(file));
        return info.exists ? (parseYaml(info.frontmatter) || {}) : {};
      }
    });
    return this.projectRepository;
  }
  _getWorkspacesPlus(){
    if (this.workspacesPlus) return this.workspacesPlus;
    this.workspacesPlus = new WorkspacesPlusAdapter(this.app);
    return this.workspacesPlus;
  }
  async ensureTodayFile(){ return this._getDailyRepository().ensureTodayFile(); }
  async readToday(){ return this._getDailyRepository().readToday(); }
  /** @param {unknown} text */
  async listUncheckedTasksFromText(text){ return this._getDailyRepository().listUncheckedTasksFromText(text); }

  /** @param {number} [amount] */
  applyTomatoAndSum(amount=1){ return this._getLegacyController().applyTomatoAndSum(amount); }
  /** @param {number} [amount] */
  bumpProjectTomato(amount=1){ return this._getLegacyController().bumpProjectTomato(amount); }
  /** @param {number} [amount] */
  safeBumpProjectTomato(amount=1){ return this._getLegacyController().safeBumpProjectTomato(amount); }

  async refreshTodaySnapshot(){
    const { file, text } = await this.readToday();
    const sum = getTomatoSum(text);
    const unchecked = await this.listUncheckedTasksFromText(text);
    return { file, sum, unchecked };
  }
  _registerDailyTaskCompletionSync(){
    if (this._dailyCompletionSyncRef || typeof this.app?.vault?.on !== "function") return;
    /** @param {any} file */
    const onModify = file => this.queueDailyTaskCompletionSync(file);
    this._dailyCompletionSyncRef = this.app.vault.on("modify", onModify);
  }
  /** @param {{path?:unknown} | null | undefined} file */
  queueDailyTaskCompletionSync(file){
    if (this._unloading || String(file?.path || "") !== this.todayFilePath()) return;
    if (this._dailyCompletionSyncTimer) window.clearTimeout(this._dailyCompletionSyncTimer);
    this._dailyCompletionSyncTimer = window.setTimeout(() => {
      this._dailyCompletionSyncTimer = null;
      this.syncCompletedTaskSelections().catch(error => logPluginError("task-completion-sync", error, {
        target:this.todayFilePath(), step:"read"
      }));
    }, 180);
  }
  async syncCompletedTaskSelections(){
    if (this._dailyCompletionSyncBusy || this._completionInFlight || this.runtime.pendingSettlement || this.runtime.status === TIMER_STATUS.FAILED || !this.app?.vault) return false;
    this._dailyCompletionSyncBusy = true;
    try {
      const daily = this._getDailyRepository();
      const file = daily.getFile(this.todayFilePath());
      if (!daily.isFile(file)) return false;
      const lines = String(await daily.read(file)).split(/\r?\n/);
      /** @param {unknown} value */
      const isCompleted = value => {
        const task = String(value || "").trim();
        if (!task) return false;
        let checked = 0;
        let unchecked = 0;
        for (const line of lines) {
          if (stripBaseName(line).toLowerCase() !== task.toLowerCase()) continue;
          if (/^\s*-\s*\[x\]\s+/i.test(line)) checked += 1;
          else if (/^\s*-\s*\[\s\]\s+/.test(line)) unchecked += 1;
        }
        return checked === 1 && unchecked === 0;
      };
      let changed = false;
      if (Array.isArray(this.settings.modules)) {
        for (const module of this.settings.modules) {
          if (module.type !== "work") continue;
          const task = this.runtime.moduleRun?.moduleId === module.id
            ? this.runtime.moduleRun.name : module.name;
          if (!isCompleted(task)) continue;
          if (this.runtime.moduleRun?.moduleId === module.id
            && /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(this.runtime.status)) {
            if (this.getElapsedMs() > 0) await this.settleFocus(true);
            else await this.completeEmptyWorkModule();
            if (this.runtime.pendingSettlement || String(this.runtime.status) === TIMER_STATUS.FAILED) continue;
          }
          changed = (await this.clearCompletedModuleTask(module.id, task)) || changed;
        }
        return changed;
      }
      return this._getLegacyController().syncCompletedTaskSelections(isCompleted);
    } finally {
      this._dailyCompletionSyncBusy = false;
    }
  }
  /** @param {unknown} text @param {"todo"|"idea"} [kind] */
  async quickCapture(text, kind="todo"){
    const content = normalizeCaptureText(text);
    if (!content) {
      new Notice("请输入要记录的内容");
      throw new Error("记录内容为空");
    }
    try {
      const result = await this._getDailyRepository().appendCapture({
        text:content,
        kind:kind === "idea" ? "idea" : "todo",
        heading:this.settings.captureHeading,
        path:this.quickCaptureFilePath()
      });
      new Notice(kind === "idea" ? "想法已保存" : "待办已保存");
      this.broadcast();
      return result;
    } catch (error) {
      if (String(error instanceof Error ? error.message : error) !== "记录内容为空") {
        logPluginError("quick-capture", error, { target:this.quickCaptureFilePath(), step:"write" });
        new Notice("快速记录失败，请检查目标路径和自动创建设置");
      }
      throw error;
    }
  }
  openQuickCaptureModal(){
    const modal = new QuickCaptureModal(this.app, (text, kind)=> this.quickCapture(text, kind));
    modal.open();
    return modal;
  }
  projectCandidates(){
    if (!this.settings.enableProjects) return [];
    return this._getProjectRepository().listCandidates({
      tag: this.settings.projectTag,
      statusKey: this.settings.projectStatusKey,
      statusWhitelist: this.settings.projectStatusWhitelist,
      projectFmKey:this.settings.projectFmKey
    });
  }
  /** @param {unknown} name */
  setCurrentTaskName(name){ return this._getLegacyController().setCurrentTaskName(name); }
  /** @param {unknown} open */
  setViewWasOpen(open){
    this.applyRuntimeEvent({ type:RUNTIME_EVENT.SET_VIEW_OPEN, open });
    this.saveState();
  }
  /** @param {unknown} path */
  setCurrentProjectPath(path){ return this._getLegacyController().setCurrentProjectPath(path); }
  /** @param {unknown} mode */
  setWorkMode(mode){ return this._getLegacyController().setWorkMode(mode); }
  /** @param {Partial<Settings>} patch */
  setCycleConfig(patch){ return this._getLegacyController().setCycleConfig(patch); }
  /** @param {unknown} enabled */
  setTaskBlackoutEnabled(enabled){ return this._getLegacyController().setTaskBlackoutEnabled(enabled); }
  /** @param {unknown} slot */
  selectCycleSlot(slot){ return this._getLegacyController().selectCycleSlot(slot); }
  /** @param {unknown} minutes @param {boolean} [broadcast] */
  setLongFocusMinutes(minutes, broadcast=true){ return this._getLegacyController().setLongFocusMinutes(minutes, broadcast); }

  // 打开当日日记
  async openToday() {
    if (this.shouldBlockFocusLayoutSideEffects({ source:"user" })) return;
    const f = await this.ensureTodayFile();
    await this.app.workspace.getLeaf(true).openFile(f);
  }
  /** @param {string} path */
  async openProject(path){
    if (!this.settings.enableProjects) return false;
    if (this.shouldBlockFocusLayoutSideEffects({ source:"user" })) return false;
    const normalized = tryNormalizeMarkdownPath(path);
    if (!normalized) { new Notice("项目路径无效"); return false; }
    const repository = this._getProjectRepository();
    const file = repository.getFile(normalized);
    if (!repository.isFile(file)) { new Notice("项目文件不存在"); return false; }
    await this.app.workspace.getLeaf(true).openFile(file);
    return true;
  }
}

Object.assign(PomodoroAIO, {
  TIMER_STATUS,
  TIMER_STAGE,
  normalizeSettings,
  normalizeRuntime,
  plannedTomatoAmount,
  actualTomatoAmount,
  workspaceLayoutLabel
});

module.exports = PomodoroAIO;
