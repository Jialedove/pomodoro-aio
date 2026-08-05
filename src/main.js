// Pomodoro AIO 源码。项目根目录的 main.js 由 esbuild 生成，请勿直接编辑。
// 变更点：项目下拉在任务上方；项目下拉后有“打开项目”；右上角新增“打开当日日记”按钮；左侧 Ribbon 加图标。

const {
  Plugin, Notice, TFile
} = require('obsidian');
const {
  parseHHMMToMinutes,
  positiveNumber,
  normalizeTag,
  formatTomatoNumber,
  isValidHHMM,
  normalizeTomatoValue
} = require("./core/validation");
const {
  getTomatoSum,
  settlementConflict
} = require("./core/task-lines");
const {
  TIMER_SCHEMA_VERSION,
  TIMER_STATUS,
  TIMER_STAGE,
  configuredStageDurationMs,
  plannedTomatoAmount,
  actualTomatoAmount,
  createSessionId,
  getElapsedMs: calculateElapsedMs,
  getRemainingMs: calculateRemainingMs
} = require("./core/timer");
const {
  buildNextStageTransition,
  buildDailySettlementPlan,
  buildSettlementJournal
} = require("./core/settlement");
const { RuntimeStore, cloneValue } = require("./services/runtime-store");
const { DailyRepository, ProjectRepository } = require("./services/repositories");
const { PomodoroView } = require("./ui/pomodoro-view");
const { PomodoroSettingTab } = require("./ui/settings-tab");
const { WorkspacesPlusAdapter, workspaceLayoutLabel } = require("./integrations/workspaces-plus");

/* ========== 默认设置 ========== */
const DEFAULT_SETTINGS = {
  // 计时
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  longEvery: 4,
  autoNext: true,

  // 当日逻辑日期
  dayStartHHMM: "00:00",

  // 当日日记路径模板（不依赖 Daily Notes）
  fallbackPattern: "Daily/{{date:YYYY-MM-DD}}.md",
  allowCreateDaily: true,

  // 任务写入
  fmKey: "番茄数",
  allowAutoCreateTask: true,
  tasksHeading: "",
  defaultTaskName: "",

  // 项目同步
  projectEnable: true,
  projectTag: "#project",
  projectStatusKey: "项目状态",
  projectStatusWhitelist: "进行中,筹划中",
  projectFmKey: "番茄数",
  currentProjectPath: "",
  showProjectSelector: true,

  // 可视化与提醒
  dailyGoal: 8,
  enableSound: true,
  enableNotify: true
  , soundWaveform: "sine",
  focusStartSound: "focus-start",
  breakStartSound: "break-start",
  focusEndSound: "focus-end",
  breakEndSound: "break-end",
  focusAlertSound: "focus-alert",
  breakAlertSound: "break-alert",
  strongAlertDelaySec: 30,
  strongAlertIntervalSec: 60,
  longFocusDefaultMin: 50,
  persistentAlertSound: true,
  ribbonClickAutoNext: true,
  focusStartCommandId: "",
  breakStartCommandId: "",

  // 循环工作：两项任务交替，无休息阶段
  workMode: "standard",
  cycleTaskA: "",
  cycleMinA: 15,
  cycleWorkspaceCommandA: "",
  cycleTaskB: "",
  cycleMinB: 15,
  cycleWorkspaceCommandB: "",

  // 兼容性
  respectModalInputFocus: true
};

/* ========== 工具函数 ========== */
function getLogicalDayKey(now, startHHMM) {
  const startMin = parseHHMMToMinutes(startHHMM) ?? 0;
  const curMin = now.getHours()*60 + now.getMinutes();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(base);
  if (curMin < startMin) d.setDate(d.getDate() - 1);
  const pad2 = (n)=> String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function renderPattern(pattern, dayKey) {
  return String(pattern||"").replace("{{date:YYYY-MM-DD}}", dayKey);
}
function createRuntimeDefaults(settings) {
  return {
    schemaVersion: TIMER_SCHEMA_VERSION,
    status: TIMER_STATUS.IDLE,
    stage: null,
    mode: settings.workMode === "cycle" ? "cycle" : "standard",
    cycleSlot: 0,
    durationMs: 0,
    startedAtMs: 0,
    elapsedMs: 0,
    remainingMs: 0,
    pausedAtMs: 0,
    sessionId: null,
    plannedTomatoCredit: plannedTomatoAmount((Number(settings.focusMin) || 25) * 60 * 1000),
    attention: null,
    pendingSettlement: null,
    projectQueue: [],
    frontmatterQueue: [],
    sessionCount: 0,
    currentTaskName: settings.defaultTaskName || "",
    longFocusMinutes: Math.max(0.1, Number(settings.longFocusDefaultMin) || Number(settings.focusMin) || 25),
    dayKey: "",
    viewWasOpen: false
  };
}
function normalizeSettings(raw={}, fallback=DEFAULT_SETTINGS) {
  const base = Object.assign({}, DEFAULT_SETTINGS, fallback || {});
  const source = raw || {};
  const result = Object.assign({}, base, source, { schemaVersion: TIMER_SCHEMA_VERSION });
  const has = key => Object.prototype.hasOwnProperty.call(source, key);
  const number = (key, min=0.1) => {
    const fallbackValue = positiveNumber(base[key], DEFAULT_SETTINGS[key], min);
    return has(key) ? positiveNumber(source[key], fallbackValue, min) : fallbackValue;
  };
  const integer = (key, min=1) => {
    const fallbackValue = Math.max(min, Math.round(Number(base[key]) || min));
    const value = Number(source[key]);
    return has(key) && Number.isFinite(value) && value >= min ? Math.round(value) : fallbackValue;
  };
  result.focusMin = number("focusMin");
  result.breakMin = number("breakMin");
  result.longBreakMin = number("longBreakMin");
  result.longFocusDefaultMin = number("longFocusDefaultMin");
  result.cycleMinA = number("cycleMinA", 1);
  result.cycleMinB = number("cycleMinB", 1);
  result.dailyGoal = number("dailyGoal");
  result.longEvery = integer("longEvery");
  result.strongAlertDelaySec = integer("strongAlertDelaySec");
  result.strongAlertIntervalSec = integer("strongAlertIntervalSec");
  result.dayStartHHMM = has("dayStartHHMM") && isValidHHMM(source.dayStartHHMM)
    ? source.dayStartHHMM : (isValidHHMM(base.dayStartHHMM) ? base.dayStartHHMM : DEFAULT_SETTINGS.dayStartHHMM);
  result.workMode = source.workMode === "cycle" || (!has("workMode") && base.workMode === "cycle") ? "cycle" : "standard";
  result.soundWaveform = ["sine", "square", "triangle"].includes(source.soundWaveform)
    ? source.soundWaveform : base.soundWaveform;
  for (const key of ["autoNext", "projectEnable", "showProjectSelector", "enableSound", "enableNotify", "persistentAlertSound", "ribbonClickAutoNext", "allowCreateDaily", "allowAutoCreateTask", "respectModalInputFocus"]) {
    if (typeof source[key] !== "boolean") result[key] = base[key];
  }
  return result;
}
function normalizeAttention(value, settings) {
  if (!value || ![TIMER_STAGE.FOCUS, TIMER_STAGE.BREAK].includes(value.type)) return null;
  const cycleSlot = Number.isInteger(value.cycleSlot) ? (value.cycleSlot === 1 ? 1 : 0) : null;
  const durationMs = Math.max(1, Number(value.durationMs) || configuredStageDurationMs(settings, value.type, !!value.isLong, cycleSlot));
  const result = {
    type: value.type,
    isLong: !!value.isLong,
    cycleSlot,
    nextStarted: !!value.nextStarted,
    durationMs
  };
  if (value.taskName !== undefined) result.taskName = String(value.taskName || "").trim();
  return result;
}
function normalizeSettlement(value) {
  if (!value || typeof value !== "object" || !String(value.sessionId || "")) return null;
  return cloneValue(value);
}
function normalizeProjectQueue(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item && typeof item === "object" && String(item.sessionId || "") && String(item.path || ""))
    .map(item => cloneValue(item));
}
function normalizeFrontmatterQueue(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item && typeof item === "object" && String(item.path || "") && String(item.key || ""))
    .map(item => cloneValue(item));
}
function normalizeRuntime(raw, settings, now=Date.now()) {
  const defaults = createRuntimeDefaults(settings);
  const source = raw || {};
  const legacy = !source.status;
  const legacyPhase = source.phase === TIMER_STAGE.FOCUS || source.phase === TIMER_STAGE.BREAK ? source.phase : null;
  const legacyPending = source.strongAlert && source.pendingPhase ? {
    type: source.pendingPhase,
    isLong: !!source.pendingIsLong,
    cycleSlot: Number.isInteger(source.pendingCycleSlot) ? source.pendingCycleSlot : null,
    nextStarted: !!source.pendingAutoStarted || source.phase === source.pendingPhase,
    durationMs: configuredStageDurationMs(settings, source.pendingPhase, !!source.pendingIsLong, source.pendingCycleSlot)
  } : null;
  const attention = normalizeAttention(source.attention || legacyPending, settings);
  const mode = source.mode === "cycle" || source.cycleActive || (legacy && settings.workMode === "cycle") ? "cycle" : "standard";
  let status = Object.values(TIMER_STATUS).includes(source.status) ? source.status : TIMER_STATUS.IDLE;
  let stage = source.stage === TIMER_STAGE.FOCUS || source.stage === TIMER_STAGE.BREAK ? source.stage : null;
  const durationMs = Math.max(0, Number(source.durationMs) || Number(source.durationSec || 0) * 1000);
  let startedAtMs = Number(source.startedAtMs) || Number(source.startedAt) || 0;
  let elapsedMs = Math.max(0, Number(source.elapsedMs) || 0);
  let remainingMs = Math.max(0, Number(source.remainingMs) || 0);
  let pausedAtMs = Number(source.pausedAtMs) || 0;

  if (legacy) {
    stage = legacyPhase;
    if (legacyPhase) status = source.paused ? TIMER_STATUS.PAUSED : TIMER_STATUS.RUNNING;
    if (attention && !attention.nextStarted) status = TIMER_STATUS.AWAITING;
    if (source.paused) {
      remainingMs = Math.max(0, Number(source.pausedLeftSec || 0) * 1000);
      elapsedMs = Math.max(0, durationMs - remainingMs);
      pausedAtMs = now;
      startedAtMs = 0;
    }
    if (status === TIMER_STATUS.AWAITING) {
      stage = null;
      remainingMs = attention?.durationMs || 0;
    }
  }

  const result = Object.assign({}, defaults, {
    schemaVersion: TIMER_SCHEMA_VERSION,
    status,
    stage,
    mode,
    cycleSlot: Number(source.cycleSlot) === 1 ? 1 : 0,
    durationMs,
    startedAtMs,
    elapsedMs,
    remainingMs,
    pausedAtMs,
    sessionId: source.sessionId || (stage === TIMER_STAGE.FOCUS && [TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED].includes(status) ? createSessionId() : null),
    plannedTomatoCredit: plannedTomatoAmount(durationMs || (Number(settings.focusMin) || 25) * 60 * 1000),
    attention,
    pendingSettlement: normalizeSettlement(source.pendingSettlement),
    projectQueue: normalizeProjectQueue(source.projectQueue),
    frontmatterQueue: normalizeFrontmatterQueue(source.frontmatterQueue),
    sessionCount: Math.max(0, Math.floor(Number(source.sessionCount) || 0)),
    currentTaskName: String(source.currentTaskName ?? defaults.currentTaskName),
    longFocusMinutes: Math.max(0.1, Number(source.longFocusMinutes) || defaults.longFocusMinutes),
    dayKey: String(source.dayKey || defaults.dayKey),
    viewWasOpen: !!source.viewWasOpen,
    failure: source.failure && typeof source.failure === "object" ? source.failure : null
  });

  if (result.attention && !result.attention.nextStarted) result.status = TIMER_STATUS.AWAITING;
  if (result.status === TIMER_STATUS.AWAITING && !result.attention) result.status = TIMER_STATUS.IDLE;
  if (result.status === TIMER_STATUS.AWAITING && result.attention?.nextStarted) result.attention.nextStarted = false;
  if ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED].includes(result.status)
    && result.attention?.nextStarted && result.stage !== result.attention.type) result.attention = null;

  if (result.status === TIMER_STATUS.IDLE) {
    result.stage = null;
    result.durationMs = 0;
    result.startedAtMs = 0;
    result.elapsedMs = 0;
    result.remainingMs = 0;
    result.pausedAtMs = 0;
    result.sessionId = null;
    result.plannedTomatoCredit = defaults.plannedTomatoCredit;
    result.attention = null;
    result.failure = null;
  } else if (result.status === TIMER_STATUS.AWAITING) {
    result.stage = null;
    result.durationMs = 0;
    result.startedAtMs = 0;
    result.elapsedMs = 0;
    result.pausedAtMs = 0;
    result.remainingMs = result.attention?.durationMs || result.remainingMs;
    result.sessionId = null;
    result.plannedTomatoCredit = 0;
    result.failure = null;
  } else if (![TIMER_STAGE.FOCUS, TIMER_STAGE.BREAK].includes(result.stage)) {
    result.status = TIMER_STATUS.IDLE;
    result.durationMs = 0;
    result.startedAtMs = 0;
    result.elapsedMs = 0;
    result.remainingMs = 0;
    result.pausedAtMs = 0;
    result.sessionId = null;
    result.plannedTomatoCredit = defaults.plannedTomatoCredit;
    result.attention = null;
    result.failure = null;
  } else if (result.status === TIMER_STATUS.PAUSED) {
    result.remainingMs = Math.min(result.durationMs, Math.max(0, result.remainingMs));
    if (!result.durationMs || result.remainingMs <= 0) {
      result.status = TIMER_STATUS.FAILED;
      result.failure = { stage: result.stage, sessionId: result.sessionId || null, atMs: now, message: "暂停状态缺少有效剩余时间" };
    } else {
      result.startedAtMs = 0;
      result.elapsedMs = result.durationMs - result.remainingMs;
      result.pausedAtMs = Number(result.pausedAtMs) || now;
    }
  } else if (result.status === TIMER_STATUS.RUNNING && (!result.durationMs || !result.startedAtMs)) {
    result.status = TIMER_STATUS.FAILED;
    result.failure = { stage: result.stage, sessionId: result.sessionId || null, atMs: now, message: "运行状态缺少有效开始时间" };
  }
  if (result.status === TIMER_STATUS.SETTLING && !result.pendingSettlement) {
    result.status = TIMER_STATUS.FAILED;
    result.failure = { stage: result.stage, sessionId: result.sessionId || null, atMs: now, message: "结算状态缺少 journal" };
  }
  if ([TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED].includes(result.status)) result.attention = null;
  if (result.stage === TIMER_STAGE.FOCUS && result.status !== TIMER_STATUS.AWAITING) result.plannedTomatoCredit = plannedTomatoAmount(result.durationMs);
  if (result.stage === TIMER_STAGE.BREAK) result.plannedTomatoCredit = 0;
  return result;
}
function playBeep(kind, enabled=true, waveform='sine', strong=false) {
  if (!enabled) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const tones = {
      'focus-start': [740, 988],
      'break-start': [660, 523],
      'focus-end': [784, 784, 1047],
      'break-end': [1047, 784, 1047],
      'focus-alert': [784, 1047, 784, 1047],
      'break-alert': [1047, 1047, 784]
    }[kind] || [520];
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
function logPluginError(operation, error, context={}) {
  const details = {
    operation,
    sessionId: context.sessionId || null,
    stage: context.stage || null,
    target: context.target || null,
    step: context.step || null,
    error: String(error?.message || error || "unknown error")
  };
  console.error("Pomodoro AIO 操作失败", details);
  return details;
}
/* ========== 后台守护 ========== */
class PomodoroAIO extends Plugin {
  async onload() {
    this._lastPersistenceError = null;
    await this.loadSettings();
    this.runtime = normalizeRuntime(await this.loadState(), this.settings);
    this._alertInterval = null;
    this._alertEscalationTimeout = null;
    this._completionInFlight = false;
    this.ribbonBadge = null;
    if (!this.runtime.dayKey) this.runtime.dayKey = this.logicalTodayKey();
    await this.saveState({ critical:true });
    await this.recoverPendingSettlement();
    try {
      await this.repairFrontmatterQueue();
    } catch (error) {
      logPluginError("startup-frontmatter-repair", error, { step:"drain" });
    }
    try {
      await this.drainProjectQueue();
    } catch (error) {
      logPluginError("startup-project-retry", error, { step:"drain" });
    }

    // 视图
    this.registerView(PomodoroView.VIEW_TYPE, (leaf)=> new PomodoroView(leaf, this));
    this.addCommand({ id: 'open-view', name: '打开番茄视图', callback: (evt)=> this.runUserCommand(()=> this.activateView(), evt) });

    // Ribbon 图标（左侧菜单栏按钮）
    this.ribbon = this.addRibbonIcon('clock', '打开番茄视图', evt => this.runUserCommand(() => this.activateView(), evt));
    if (this.ribbon) {
      this.ribbon.addClass("pomodoro-ribbon");
      this.ribbonBadge = this.ribbon.createDiv({ cls:"pomodoro-ribbon-badge" });
      const originalClick = this.ribbon.onclick?.bind(this.ribbon);
      this.ribbon.onclick = (evt) => {
        this.onRibbonClick(evt);
        if (originalClick) originalClick(evt);
      };
    }

    // 命令
    this.addCommand({ id: 'start-focus', name: '开始专注', callback: (evt)=> this.runUserCommand(()=> this.startFocus(), evt) });
    this.addCommand({ id: 'start-break', name: '开始短休', callback: (evt)=> this.runUserCommand(()=> this.startBreak(false), evt) });
    this.addCommand({ id: 'start-long-break', name: '开始长休', callback: (evt)=> this.runUserCommand(()=> this.startBreak(true), evt) });
    this.addCommand({ id: 'pause-resume', name: '暂停/继续', callback: (evt)=> this.runUserCommand(()=> this.togglePause(), evt) });
    this.addCommand({ id: 'reset', name: '重置', callback: (evt)=> this.runUserCommand(()=> this.reset(), evt) });
    this.addCommand({ id: 'complete-now', name: '立刻结算当前专注（按实际时长）', callback: (evt)=> this.runUserCommand(()=> this.forceCompleteFocusOnce(), evt) });
    this.addCommand({ id: 'open-today', name: '打开当日日记', callback: (evt)=> this.runUserCommand(()=> this.openToday(), evt) });

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
  }
  async onunload(){
    this._unloading = true;
    this.stopPersistentAlertSound();
    if (this._tickTimeout) window.clearTimeout(this._tickTimeout);
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
        new Notice("番茄钟状态保存失败，后续操作仍会保留并继续重试");
      }
    });
    return this.runtimeStore;
  }
  async loadState(){ return this._getRuntimeStore().loadRuntime(); }
  async flushPendingSaves(){ await this._getRuntimeStore().flush(); }
  async saveState(options={}){
    return this._getRuntimeStore().saveRuntime(this.runtime, options);
  }
  async loadSettings(){
    const data = await this._getRuntimeStore().loadSettings();
    this.settings = normalizeSettings(data || {});
    return this.settings;
  }
  async saveSettings(){
    return this._getRuntimeStore().saveSettings(this.settings);
  }

  /* ====== 环境守护 ====== */
  respectGuardsEnabled(){ return this.settings?.respectModalInputFocus !== false; }
  isElementVisible(el){
    if (!el) return false;
    try {
      const style = window.getComputedStyle?.(el);
      if (style) {
        if (style.display === "none") return false;
        if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      }
      if (el.offsetParent === null && style?.position !== "fixed") return false;
      return true;
    } catch { return true; }
  }
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
        ".quick-switcher", ".command-palette", ".mod-command-palette"
      ];
      const nodes = root?.querySelectorAll?.(selectors.join(", ")) || [];
      for (const el of nodes) {
        if (this.isElementVisible(el)) return true;
      }
      return false;
    } catch { return false; }
  }
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
  runUserCommand(fn, evt){
    if (this.shouldBlockHotkeys(evt, { allowInText:true })) return false;
    if (this.shouldBlockFocusLayoutSideEffects({ source:"user" })) return false;
    try {
      const result = fn();
      result?.catch?.(error => logPluginError("user-command", error, { step:"execute" }));
    } catch(err){ logPluginError("user-command", err, { step:"execute" }); }
    return true;
  }
  runAutoAction(fn){
    if (this.shouldBlockFocusLayoutSideEffects({ source:"auto" })) return false;
    try {
      const result = fn();
      result?.catch?.(error => logPluginError("auto-action", error, { step:"execute" }));
    } catch(err){ logPluginError("auto-action", err, { step:"execute" }); }
    return true;
  }

  /* ====== 视图与广播 ====== */
  async activateView(opts={}) {
    const source = opts.source || "user";
    if (this.shouldBlockFocusLayoutSideEffects({ source })) return;
    const leaves = this.app.workspace.getLeavesOfType(PomodoroView.VIEW_TYPE);
    if (leaves.length) { this.app.workspace.revealLeaf(leaves[0]); return; }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: PomodoroView.VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  broadcast() {
    const snap = this.snapshot();
    this.updateRibbonVisuals(snap.runtime);
    this.app.workspace.trigger('pomodoro:aio-state', snap);
  }
  snapshot(){
    const leftMs = this.getLeftMs();
    return {
      settings: this.settings,
      runtime: Object.assign({}, this.runtime, { leftMs, leftSec: Math.ceil(leftMs / 1000) })
    };
  }
  updateRibbonVisuals(runtime){
    if (!this.ribbon) return;
    const r = runtime || Object.assign({}, this.runtime, { leftSec: this.getLeftSec() });
    this.updateRibbonBadge(r);
    this.updateRibbonAlertUI(!!r.attention);
  }
  updateRibbonBadge(runtime){
    if (!this.ribbonBadge) return;
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
  onRibbonClick(evt){
    if (!this.runtime.attention) return;
    if (!this.settings.ribbonClickAutoNext || this.runtime.attention.nextStarted) {
      this.stopStrongAlert();
      return;
    }
    this.startPendingStage();
  }
  startPendingStage(){
    const next = this.runtime.attention;
    if (!next || next.nextStarted) { this.stopStrongAlert(); return; }
    if (next.type === TIMER_STAGE.BREAK) this.startBreak(next.isLong, { forceRun:true, cause:'manual', durationMs:next.durationMs, allowTransition:true });
    else if (next.type === TIMER_STAGE.FOCUS && Number.isInteger(next.cycleSlot)) {
      const options = { cause:'manual', durationMs:next.durationMs, allowTransition:true };
      if (next.taskName !== undefined) options.taskName = next.taskName;
      this.startCycle(next.cycleSlot, options);
    }
    else if (next.type === TIMER_STAGE.FOCUS) this.startFocus({ cause:'manual', durationMs:next.durationMs, allowTransition:true });
    else this.stopStrongAlert();
  }
  beginStrongAlert(nextPhase){
    const type = nextPhase?.type;
    if (![TIMER_STAGE.FOCUS, TIMER_STAGE.BREAK].includes(type)) return;
    const cycleSlot = Number.isInteger(nextPhase?.cycleSlot) ? (nextPhase.cycleSlot === 1 ? 1 : 0) : null;
    const attention = {
      type,
      isLong: !!nextPhase?.isLong,
      cycleSlot,
      nextStarted: !!nextPhase?.autoStarted,
      durationMs: Math.max(1, Number(nextPhase?.durationMs) || configuredStageDurationMs(this.settings, type, !!nextPhase?.isLong, cycleSlot))
    };
    if (nextPhase?.taskName !== undefined) attention.taskName = String(nextPhase.taskName || "").trim();
    this.runtime.attention = attention;
    if (!attention.nextStarted) this.clearStageTiming(TIMER_STATUS.AWAITING);
    this.saveState();
    this.updateRibbonAlertUI(true);
    this.startPersistentAlertSound();
    this.broadcast();
  }
  stopStrongAlert(){
    if (!this.runtime.attention) {
      this.stopPersistentAlertSound();
      this.updateRibbonAlertUI(false);
      return;
    }
    this.runtime.attention = null;
    this.saveState();
    this.stopPersistentAlertSound();
    this.updateRibbonAlertUI(false);
    this.updateRibbonBadge();
    this.broadcast();
  }
  focusCompletionBody(tomatoAmount, next){
    const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
    return `${task ? `完成：${task} · ` : ""}+${formatTomatoNumber(tomatoAmount)}🍅\n下一步：${next}`;
  }
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
  isWorkspaceLayoutActive(commandId){
    return this._getWorkspacesPlus().isLayoutActive(commandId);
  }

  /* ====== 计时控制 ====== */
  getLeftMs(){
    return calculateRemainingMs(this.runtime, this.settings);
  }
  getElapsedMs(at=Date.now()){
    return calculateElapsedMs(this.runtime, at);
  }
  /** @param {string} [status] */
  clearStageTiming(status=TIMER_STATUS.IDLE){
    const r = this.runtime;
    r.status = status;
    r.stage = null;
    r.durationMs = 0;
    r.startedAtMs = 0;
    r.elapsedMs = 0;
    r.remainingMs = status === TIMER_STATUS.AWAITING ? Math.max(0, Number(r.attention?.durationMs) || 0) : 0;
    r.pausedAtMs = 0;
    r.sessionId = null;
    r.plannedTomatoCredit = 0;
  }
  startStage(stage, durationMs, session=false){
    const r = this.runtime;
    const now = Date.now();
    r.status = TIMER_STATUS.RUNNING;
    r.stage = stage;
    r.durationMs = Math.max(1, Math.round(Number(durationMs) || 1));
    r.startedAtMs = now;
    r.elapsedMs = 0;
    r.remainingMs = r.durationMs;
    r.pausedAtMs = 0;
    r.sessionId = session ? createSessionId() : null;
    r.plannedTomatoCredit = stage === TIMER_STAGE.FOCUS ? plannedTomatoAmount(r.durationMs) : 0;
    delete r.failure;
  }
  getLeftSec(){
    return Math.ceil(this.getLeftMs() / 1000);
  }
  ensureDayFreshness(){
    const cur = this.logicalTodayKey();
    if (this.runtime.dayKey !== cur){
      this.runtime.dayKey = cur;
      this.runtime.sessionCount = 0; // 跨天清空“本次已完成段数”
      this.saveState();
      this.broadcast();
    }
  }
  startFocus(options){
    let opts = { suppressNotify:false, cause:'manual', minutes:null, cycle:false };
    if (typeof options === 'boolean') opts.suppressNotify = options;
    else if (options && typeof options === 'object') opts = Object.assign(opts, options);
    if (this.runtime.pendingSettlement && !opts.allowPendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    if (!opts.allowTransition && (this.runtime.status !== TIMER_STATUS.IDLE || this.runtime.attention)) {
      new Notice("当前已有计时，请先完成或重置当前阶段");
      return false;
    }
    this.ensureDayFreshness();
    const requestedDurationMs = Number(opts.durationMs);
    const durationMs = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0 ? Math.round(requestedDurationMs) : 0;
    const minutesRaw = typeof opts.minutes === 'number' && isFinite(opts.minutes) && opts.minutes > 0 ? opts.minutes : (this.settings.focusMin || 25);
    const minutes = durationMs ? durationMs / 60_000 : Math.max(0.1, minutesRaw);
    if (opts.minutes != null && !opts.cycle) this.setLongFocusMinutes(minutes, false);
    this.stopStrongAlert();
    if (!opts.cycle) {
      this.runtime.mode = 'standard';
      this.runtime.cycleSlot = 0;
    } else this.runtime.mode = 'cycle';
    this.startStage(TIMER_STAGE.FOCUS, durationMs || minutes * 60 * 1000, true);
    this.saveState();
    this.broadcast();
    playBeep(this.settings.focusStartSound, this.settings.enableSound, this.settings.soundWaveform);
    if (!opts.suppressNotify) {
      const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
      sysNotify("开始专注", `${formatTomatoNumber(minutes)} 分钟${task ? ` · 任务：${task}` : ""}`, this.settings.enableNotify);
    }
    const commandId = opts.cycle
      ? (this.runtime.cycleSlot === 1 ? this.settings.cycleWorkspaceCommandB : this.settings.cycleWorkspaceCommandA)
      : this.settings.focusStartCommandId;
    if (opts.cause !== 'auto' && commandId) this.executeStageCommand(commandId);
    this._resyncTick();
  }
  startCycle(slot=this.runtime.cycleSlot, options={}){
    if (this.runtime.pendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    if (!options?.allowTransition && (this.runtime.status !== TIMER_STATUS.IDLE || this.runtime.attention)) {
      new Notice("当前已有计时，请先完成或重置当前阶段");
      return false;
    }
    const cycleSlot = slot === 1 ? 1 : 0;
    const hasTaskSnapshot = Object.prototype.hasOwnProperty.call(options || {}, "taskName");
    const configuredTask = cycleSlot ? this.settings.cycleTaskB : this.settings.cycleTaskA;
    const task = String(hasTaskSnapshot ? options.taskName : configuredTask || "").trim();
    const requestedDurationMs = Number(options?.durationMs);
    const minutes = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0
      ? requestedDurationMs / 60_000
      : Number(cycleSlot ? this.settings.cycleMinB : this.settings.cycleMinA);
    if (!task) { new Notice(`请先填写任务 ${cycleSlot ? "B" : "A"}`); return; }
    if (!isFinite(minutes) || minutes <= 0) { new Notice(`请设置任务 ${cycleSlot ? "B" : "A"} 的时长`); return; }
    this.runtime.mode = 'cycle';
    this.runtime.cycleSlot = cycleSlot;
    this.runtime.currentTaskName = task;
    this.startFocus(Object.assign({ cause:'manual', minutes, cycle:true }, options));
  }
  startBreak(isLong=false, options){
    let opts = { forceRun:true, suppressNotify:false, cause:'manual' };
    if (typeof options === 'boolean') opts.forceRun = options;
    else if (options && typeof options === 'object') opts = Object.assign(opts, options);
    if (this.runtime.pendingSettlement && !opts.allowPendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    if (!opts.allowTransition && (this.runtime.status !== TIMER_STATUS.IDLE || this.runtime.attention)) {
      new Notice("当前已有计时，请先完成或重置当前阶段");
      return false;
    }
    this.ensureDayFreshness();
    this.stopStrongAlert();
    this.runtime.mode = 'standard';
    this.runtime.cycleSlot = 0;
    const requestedDurationMs = Number(opts.durationMs);
    const durationMs = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0
      ? Math.round(requestedDurationMs)
      : Math.max(1, Math.round((isLong ? (this.settings.longBreakMin||15) : (this.settings.breakMin||5)) * 60 * 1000));
    const minutes = durationMs / 60_000;
    const forceRun = opts.forceRun ?? true;
    const shouldRun = forceRun !== false && (forceRun || !!this.settings.autoNext);
    if (shouldRun) this.startStage(TIMER_STAGE.BREAK, durationMs, false);
    else {
      this.clearStageTiming(TIMER_STATUS.AWAITING);
      this.runtime.remainingMs = durationMs;
    }
    this.saveState();
    this.broadcast();
    playBeep(this.settings.breakStartSound, this.settings.enableSound, this.settings.soundWaveform);
    if (!opts.suppressNotify) {
      const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
      sysNotify("开始休息", `${formatTomatoNumber(minutes)} 分钟${task ? ` · 刚完成：${task}` : ""}`, this.settings.enableNotify);
    }
    if (opts.cause !== 'auto' && this.settings.breakStartCommandId) this.executeStageCommand(this.settings.breakStartCommandId);
    this._resyncTick();
  }
  togglePause(triggerCommand=false){
    this.ensureDayFreshness();
    const r = this.runtime;
    if (![TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED].includes(r.status)) return false;
    const wasPaused = r.status === TIMER_STATUS.PAUSED;
    this.stopStrongAlert();
    if (!wasPaused){
      const now = Date.now();
      const elapsedMs = this.getElapsedMs(now);
      if (elapsedMs >= r.durationMs) {
        const completion = r.stage === TIMER_STAGE.FOCUS ? this.settleFocus(false) : this.settleBreak();
        completion?.catch(error => logPluginError("pause-at-boundary", error, {
          sessionId: r.sessionId,
          stage: r.stage,
          step: "settle"
        }));
        return false;
      }
      r.elapsedMs = elapsedMs;
      r.remainingMs = Math.max(0, r.durationMs - elapsedMs);
      r.startedAtMs = 0;
      r.pausedAtMs = now;
      r.status = TIMER_STATUS.PAUSED;
    } else {
      r.startedAtMs = Date.now();
      r.pausedAtMs = 0;
      r.status = TIMER_STATUS.RUNNING;
      r.remainingMs = Math.max(0, r.durationMs - r.elapsedMs);
    }
    this.saveState(); this.broadcast();
    this._resyncTick();
    if (triggerCommand && wasPaused && r.status === TIMER_STATUS.RUNNING) {
      const focusCommandId = r.mode === 'cycle'
        ? (r.cycleSlot === 1 ? this.settings.cycleWorkspaceCommandB : this.settings.cycleWorkspaceCommandA)
        : this.settings.focusStartCommandId;
      if (r.stage === TIMER_STAGE.FOCUS && focusCommandId) this.executeStageCommand(focusCommandId);
      else if (r.stage === TIMER_STAGE.BREAK && this.settings.breakStartCommandId) this.executeStageCommand(this.settings.breakStartCommandId);
    }
    return true;
  }
  reset(showNotice=true){
    if (this.runtime.pendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    this.ensureDayFreshness();
    this.stopStrongAlert();
    this.runtime.mode = this.settings.workMode === 'cycle' ? 'cycle' : 'standard';
    this.runtime.cycleSlot = 0;
    this.clearStageTiming(TIMER_STATUS.IDLE);
    this.saveState(); this.broadcast();
    this._resyncTick();
    if (showNotice) new Notice("已重置");
    return true;
  }

  /* ====== 到点/补记 ====== */
  async tick(){
    this.ensureDayFreshness();
    // 每次对齐触发时先广播，保证视图秒表顺滑
    this.broadcast();
    if (this._completionInFlight) return;

    const r = this.runtime;
    if (r.status !== TIMER_STATUS.RUNNING || !r.startedAtMs || !r.durationMs) return;

    const leftMs = this.getLeftMs();
    if (leftMs > 0) return;

    if (r.stage === TIMER_STAGE.FOCUS) await this.settleFocus(false);
    else if (r.stage === TIMER_STAGE.BREAK) await this.settleBreak();
  }
  async forceCompleteFocusOnce(){
    this.ensureDayFreshness();
    if (![TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED].includes(this.runtime.status) || this.runtime.stage !== TIMER_STAGE.FOCUS) {
      new Notice("当前不在专注阶段"); return;
    }
    if (this._completionInFlight) { new Notice("正在结算当前专注"); return; }
    if (this.getElapsedMs() <= 0) { new Notice("尚未产生有效专注时长"); return; }
    await this.settleFocus(true);
  }

  async settleFocus(manual=false){
    const r = this.runtime;
    if (this._completionInFlight || ![TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED].includes(r.status) || r.stage !== TIMER_STAGE.FOCUS) return;
    this._completionInFlight = true;
    const elapsedMs = this.getElapsedMs();
    const tomatoAmount = manual ? actualTomatoAmount(elapsedMs) : plannedTomatoAmount(r.durationMs);
    r.sessionId ||= createSessionId();
    r.status = TIMER_STATUS.SETTLING;
    try {
      if (!r.pendingSettlement || r.pendingSettlement.sessionId !== r.sessionId) {
        const sessionCountAfter = (r.sessionCount || 0) + 1;
        const transition = buildNextStageTransition(this.settings, r, sessionCountAfter);
        r.pendingSettlement = await this.prepareSettlement(tomatoAmount, transition, sessionCountAfter, manual);
        await this.saveState({ critical:true });
      }
      await this.resumePendingSettlement();
    } catch (error) {
      this.markSettlementFailed(error, { operation:"settleFocus", step:"prepareOrResume" });
    } finally {
      this._completionInFlight = false;
    }
  }
  async prepareSettlement(amount, transition, sessionCountAfter, manual=false){
    const path = this.todayFilePath();
    const dailyRepository = this._getDailyRepository();
    const { text: sourceText } = await dailyRepository.readPath(path);
    const taskName = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
    const daily = buildDailySettlementPlan(sourceText, {
      path,
      taskName,
      frontmatterKey: this.settings.fmKey || "番茄数",
      amount,
      settings: this.settings
    });
    return buildSettlementJournal({
      sessionId: this.runtime.sessionId,
      durationMs: this.runtime.durationMs,
      taskName,
      amount,
      manual,
      sessionCountAfter,
      transition,
      createdAtMs: Date.now(),
      daily,
      project: this.prepareProjectSettlement(amount)
    });
  }
  prepareProjectSettlement(amount){
    return this._getProjectRepository().prepareSettlementPlan({
      path: this.settings.currentProjectPath,
      key: this.settings.projectFmKey,
      amount,
      enabled: this.settings.projectEnable
    });
  }
  async applyDailySettlement(journal){
    const daily = journal.daily;
    if (!daily || !daily.path) throw new Error("结算 journal 缺少日记写入计划");
    const dailyRepository = this._getDailyRepository();
    let file = dailyRepository.getFile(daily.path);
    if (!file) {
      if (daily.rowStatus === "applied") throw settlementConflict("已完成的日记文件不存在，无法安全恢复");
      file = await this.ensureTodayFile();
    }
    if (!dailyRepository.isFile(file)) throw new Error("当天路径不是文件");

    let currentText = "";
    if (daily.rowStatus !== "applied") {
      const mutation = await dailyRepository.applyPlannedMutation(file, daily);
      currentText = mutation.text;
      daily.rowStatus = "applied";
      daily.alreadyApplied = mutation.alreadyApplied;
    }
    if (!currentText) currentText = await dailyRepository.read(file);
    daily.expectedSum = getTomatoSum(currentText);
    if (daily.frontmatterStatus !== "applied") {
      try {
        await dailyRepository.processFrontMatter(file, fm=>{ fm[daily.frontmatterKey] = daily.expectedSum; });
        daily.frontmatterStatus = "applied";
        this.removeFrontmatterRepair(daily.path, daily.frontmatterKey);
      } catch (error) {
        daily.frontmatterStatus = "pending";
        daily.frontmatterError = String(error?.message || error);
        logPluginError("daily-settlement", error, {
          sessionId: journal.sessionId,
          stage: journal.stage,
          target: daily.path,
          step: "frontmatter"
        });
        this.upsertFrontmatterRepair({
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
    await this.saveState({ critical:true });
  }
  async applyProjectPlan(plan){
    return this._getProjectRepository().applyPlan(plan);
  }
  async applyProjectSettlement(journal){
    const project = journal.project;
    if (!project || project.status === "skipped") {
      journal.status = "projectApplied";
      await this.saveState({ critical:true });
      return;
    }
    const result = await this.applyProjectPlan(project);
    project.status = result.status;
    if (result.error) project.error = result.error;
    if (result.error) {
      logPluginError("project-settlement", new Error(result.error), {
        sessionId: journal.sessionId,
        stage: journal.stage,
        target: project.path,
        step: result.status === "conflict" ? "conflict" : "write"
      });
    }
    if (result.status === "applied") this.removeProjectRetry(project.sessionId || journal.sessionId, project.path);
    else this.upsertProjectRetry({ ...project, sessionId: journal.sessionId });
    journal.status = "projectApplied";
    await this.saveState({ critical:true });
  }
  upsertProjectRetry(item){
    const queue = this.runtime.projectQueue || (this.runtime.projectQueue = []);
    const copy = cloneValue(item);
    const index = queue.findIndex(entry=> entry.sessionId === copy.sessionId && entry.path === copy.path);
    if (index === -1) queue.push(copy);
    else queue[index] = copy;
  }
  removeProjectRetry(sessionId, path){
    this.runtime.projectQueue = (this.runtime.projectQueue || []).filter(item=> !(item.sessionId === sessionId && item.path === path));
  }
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
  upsertFrontmatterRepair(item){
    const queue = this.runtime.frontmatterQueue || (this.runtime.frontmatterQueue = []);
    const copy = cloneValue(item);
    const index = queue.findIndex(entry=> entry.sessionId === copy.sessionId && entry.path === copy.path && entry.key === copy.key);
    if (index === -1) queue.push(copy);
    else queue[index] = copy;
  }
  removeFrontmatterRepair(path, key, sessionId){
    this.runtime.frontmatterQueue = (this.runtime.frontmatterQueue || []).filter(item=> !(item.path === path && item.key === key && (!sessionId || item.sessionId === sessionId)));
  }
  async repairFrontmatterQueue(){
    const dailyRepository = this._getDailyRepository();
    const queue = this.runtime.frontmatterQueue || [];
    let changed = false;
    for (let i=queue.length-1; i>=0; i--) {
      const item = queue[i];
      try {
        const file = this.app.vault.getAbstractFileByPath(item.path);
        if (!file || !(file instanceof TFile)) continue;
        item.expectedSum = getTomatoSum(await dailyRepository.read(file));
        await dailyRepository.processFrontMatter(file, fm=>{ fm[item.key] = normalizeTomatoValue(item.expectedSum); });
        queue.splice(i, 1);
        changed = true;
      } catch (error) {
        item.error = String(error?.message || error);
        changed = true;
        logPluginError("frontmatter-repair", error, {
          sessionId: item.sessionId,
          stage: TIMER_STAGE.FOCUS,
          target: item.path,
          step: "retry"
        });
      }
    }
    if (changed) await this.saveState();
  }
  async drainProjectQueue(){
    const queue = this.runtime.projectQueue || [];
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
      try {
        result = await this.applyProjectPlan(item);
      } catch (error) {
        result = { status: "pending", error: String(error?.message || error) };
      }
      item.status = result.status;
      if (result.error) item.error = result.error;
      if (result.error) {
        logPluginError("project-retry", new Error(result.error), {
          sessionId: item.sessionId,
          stage: TIMER_STAGE.FOCUS,
          target: item.path,
          step: result.status === "conflict" ? "conflict" : "retry"
        });
      }
      if (result.status === "applied" || result.status === "skipped") {
        if (result.status === "applied") this.rebaseProjectSuccessors(queue, i + 1, item);
        queue.splice(i, 1);
      } else {
        blockedKeys.add(key);
        i += 1;
      }
      changed = true;
    }
    if (changed) await this.saveState();
  }
  async finalizeFocusSettlement(journal){
    const r = this.runtime;
    r.sessionCount = Math.max(r.sessionCount || 0, Number(journal.sessionCountAfter) || 0);
    r.sessionId = journal.sessionId;
    journal.status = "runtimeFinalizing";
    await this.saveState({ critical:true });

    if (!journal.notified) {
      playBeep(this.settings.focusEndSound, this.settings.enableSound, this.settings.soundWaveform);
      if (journal.transition.mode === "cycle") {
        const nextTask = Object.prototype.hasOwnProperty.call(journal.transition, "taskName")
          ? String(journal.transition.taskName || "").trim()
          : String((journal.transition.cycleSlot === 1 ? this.settings.cycleTaskB : this.settings.cycleTaskA) || "").trim();
        sysNotify(journal.manual ? "专注完成（手动）" : "专注完成", this.focusCompletionBody(journal.amount, `${nextTask || "下一段专注"}（点击番茄图标开始）`), this.settings.enableNotify);
      } else {
        const breakMinutes = journal.transition.durationMs / 60 / 1000;
        sysNotify(journal.manual ? "专注完成（手动）" : "专注完成", this.focusCompletionBody(journal.amount, `${journal.transition.isLong ? "长休" : "短休"} ${formatTomatoNumber(breakMinutes)} 分钟${journal.transition.autoNext ? "（已开始）" : "（点击番茄图标开始）"}`), this.settings.enableNotify);
      }
      journal.notified = true;
      await this.saveState({ critical:true });
    }

    if (journal.transition.mode === "cycle") {
      const already = r.status === TIMER_STATUS.AWAITING
        && r.attention?.type === TIMER_STAGE.FOCUS
        && r.attention?.cycleSlot === journal.transition.cycleSlot;
      if (!already) {
        r.mode = "cycle";
        r.cycleSlot = journal.transition.cycleSlot;
        this.clearStageTiming(TIMER_STATUS.AWAITING);
        this.beginStrongAlert({ type:TIMER_STAGE.FOCUS, cycleSlot:r.cycleSlot, taskName:journal.transition.taskName, autoStarted:false, durationMs:journal.transition.durationMs });
      }
    } else {
      const attentionMatches = !r.attention
        || (r.attention.type === TIMER_STAGE.BREAK && !!r.attention.isLong === !!journal.transition.isLong);
      const existingBreak = journal.transition.autoNext
        && r.stage === TIMER_STAGE.BREAK
        && Math.round(Number(r.durationMs) || 0) === Math.round(Number(journal.transition.durationMs) || 0)
        && [TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING].includes(r.status)
        && (Number(r.startedAtMs) > 0 || (Number(r.pausedAtMs) > 0 && Number(r.remainingMs) > 0))
        && attentionMatches;
      const alreadyAwaiting = !journal.transition.autoNext
        && r.status === TIMER_STATUS.AWAITING
        && r.attention?.type === TIMER_STAGE.BREAK
        && !!r.attention?.isLong === !!journal.transition.isLong;
      if (!existingBreak && !alreadyAwaiting) {
        this.startBreak(journal.transition.isLong, {
          forceRun: journal.transition.autoNext,
          cause: journal.manual ? "manual" : "auto",
          suppressNotify: true,
          durationMs: journal.transition.durationMs,
          allowTransition: true,
          allowPendingSettlement: true
        });
      } else if (existingBreak && r.status === TIMER_STATUS.SETTLING) {
        r.status = r.startedAtMs ? TIMER_STATUS.RUNNING : TIMER_STATUS.PAUSED;
        r.sessionId = null;
        r.plannedTomatoCredit = 0;
      }
      this.beginStrongAlert({
        type:TIMER_STAGE.BREAK,
        isLong:journal.transition.isLong,
        autoStarted:journal.transition.autoNext,
        durationMs:journal.transition.durationMs
      });
    }
    journal.status = "settled";
    await this.saveState({ critical:true });
    r.pendingSettlement = null;
    await this.saveState({ critical:true });
    this.broadcast();
    this._resyncTick();
  }
  async resumePendingSettlement(){
    const journal = this.runtime.pendingSettlement;
    if (!journal) return;
    this.runtime.status = TIMER_STATUS.SETTLING;
    this.runtime.sessionId = journal.sessionId;
    if (journal.status === "prepared" || journal.status === "dailyApplied" || journal.status === "projectApplied") {
      this.runtime.stage = TIMER_STAGE.FOCUS;
      this.runtime.durationMs = journal.durationMs;
    }
    delete this.runtime.failure;
    await this.applyDailySettlement(journal);
    await this.applyProjectSettlement(journal);
    await this.finalizeFocusSettlement(journal);
  }
  async recoverPendingSettlement(){
    if (!this.runtime.pendingSettlement) return;
    this._completionInFlight = true;
    try {
      await this.resumePendingSettlement();
    } catch (error) {
      this.markSettlementFailed(error, { operation:"recoverPendingSettlement", step:"resume" });
    } finally {
      this._completionInFlight = false;
    }
  }
  async settleBreak(){
    const r = this.runtime;
    if (this._completionInFlight || r.status !== TIMER_STATUS.RUNNING || r.stage !== TIMER_STAGE.BREAK) return;
    this._completionInFlight = true;
    r.status = TIMER_STATUS.SETTLING;
    this.saveState(); this.broadcast();
    try {
      playBeep(this.settings.breakEndSound, this.settings.enableSound, this.settings.soundWaveform);
      const autoNext = !!this.settings.autoNext;
      const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
      sysNotify("休息结束", `下一步：${autoNext ? "已开始" : "点击番茄图标开始"}专注${task ? ` · 任务：${task}` : ""}`, this.settings.enableNotify);
      if (autoNext) this.startFocus({ suppressNotify:true, cause:'auto', allowTransition:true });
      else this.clearStageTiming(TIMER_STATUS.AWAITING);
      this.beginStrongAlert({ type:TIMER_STAGE.FOCUS, autoStarted:autoNext, durationMs:configuredStageDurationMs(this.settings, TIMER_STAGE.FOCUS) });
      this._resyncTick();
    } catch (error) {
      this.markSettlementFailed(error, { operation:"settleBreak", step:"advanceFocus" });
    } finally {
      this._completionInFlight = false;
    }
  }
  markSettlementFailed(error, context={}){
    const r = this.runtime;
    const details = logPluginError(context.operation || "settlement", error, {
      ...context,
      sessionId: context.sessionId || r.sessionId || r.pendingSettlement?.sessionId,
      stage: context.stage || r.stage || r.pendingSettlement?.stage,
      target: context.target || r.pendingSettlement?.daily?.path || r.pendingSettlement?.project?.path
    });
    r.status = TIMER_STATUS.FAILED;
    r.failure = {
      ...details,
      atMs: Date.now(),
      message: details.error
    };
    this.saveState(); this.broadcast();
    new Notice("结算失败，journal 已保留，请重载插件恢复");
  }

  _resyncTick(){
    if (this._tickTimeout) window.clearTimeout(this._tickTimeout);
    this._scheduleTick && this._scheduleTick();
  }

  /* ====== 文件相关 ====== */
  logicalTodayKey(now=new Date()){ return getLogicalDayKey(now, this.settings.dayStartHHMM || "00:00"); }
  todayFilePath(){
    return renderPattern(this.settings.fallbackPattern || "Daily/{{date:YYYY-MM-DD}}.md", this.logicalTodayKey());
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
      isFile: file => file instanceof TFile
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
  async listUncheckedTasksFromText(text){ return this._getDailyRepository().listUncheckedTasksFromText(text); }

  // 当日任务行尾追加对应 🍅 数量，并写入 frontmatter[fmKey]；返回今日累计
  async applyTomatoAndSum(amount=1){
    const result = await this._getDailyRepository().addTomatoAndSum({
      taskName: this.runtime.currentTaskName || this.settings.defaultTaskName,
      amount,
      settings: this.settings,
      frontmatterKey: this.settings.fmKey || "番茄数"
    });
    if (result.frontmatterError) {
      logPluginError("daily-settlement", result.frontmatterError, {
        sessionId: this.runtime.sessionId,
        stage: this.runtime.stage,
        target: result.file.path,
        step: "frontmatter"
      });
      this.upsertFrontmatterRepair({
        path: result.file.path,
        key: this.settings.fmKey || "番茄数",
        expectedSum: result.sum,
        error: String(result.frontmatterError?.message || result.frontmatterError)
      });
      this.saveState();
      new Notice("当日日记 frontmatter 汇总写入失败，任务行记录已保留");
    }
    this.broadcast();
    return result.sum;
  }

  // 为所选项目文件 frontmatter[projectFmKey] +1
  async bumpProjectTomato(amount=1){
    if (!this.settings.projectEnable) return;
    await this._getProjectRepository().bumpTomato({
      path: this.settings.currentProjectPath,
      key: this.settings.projectFmKey,
      amount
    });
  }
  async safeBumpProjectTomato(amount=1){
    try {
      await this.bumpProjectTomato(amount);
    } catch (err) {
      logPluginError("project-sync", err, {
        sessionId: this.runtime.sessionId,
        stage: this.runtime.stage,
        target: this.settings.currentProjectPath,
        step: "write"
      });
      new Notice("项目番茄同步失败，已保留当日日记记录");
    }
  }

  /* ====== 提供给视图的查询/动作 ====== */
  async refreshTodaySnapshot(){
    const { file, text } = await this.readToday();
    const sum = getTomatoSum(text);
    const unchecked = await this.listUncheckedTasksFromText(text);
    return { file, sum, unchecked };
  }
  projectCandidates(){
    return this._getProjectRepository().listCandidates({
      tag: this.settings.projectTag,
      statusKey: this.settings.projectStatusKey,
      statusWhitelist: this.settings.projectStatusWhitelist
    });
  }
  setCurrentTaskName(name){
    this.runtime.currentTaskName = String(name||"").trim();
    this.saveState(); this.broadcast();
  }
  setViewWasOpen(open){
    this.runtime.viewWasOpen = !!open;
    this.saveState();
  }
  setCurrentProjectPath(path){
    this.settings.currentProjectPath = String(path||"").trim();
    this.saveSettings(); this.broadcast();
  }
  setWorkMode(mode){
    if (this.runtime.status !== TIMER_STATUS.IDLE || this.runtime.attention) { new Notice("请先重置当前计时，再切换工作模式"); return false; }
    this.settings = normalizeSettings({ ...this.settings, workMode: mode === 'cycle' ? 'cycle' : 'standard' }, this.settings);
    this.saveSettings(); this.broadcast();
    return true;
  }
  setCycleConfig(patch){
    this.settings = normalizeSettings({ ...this.settings, ...patch }, this.settings);
    this.saveSettings(); this.broadcast();
  }
  selectCycleSlot(slot){
    if (this.settings.workMode !== 'cycle' || this.runtime.status !== TIMER_STATUS.IDLE || this.runtime.attention) return false;
    this.runtime.cycleSlot = slot === 1 ? 1 : 0;
    this.saveState(); this.broadcast();
    return true;
  }
  setLongFocusMinutes(minutes, broadcast=true){
    const num = Number(minutes);
    if (!isFinite(num)) return;
    const normalized = Math.max(0.1, Math.round(num * 10) / 10);
    this.runtime.longFocusMinutes = normalized;
    this.saveState();
    if (broadcast) this.broadcast();
  }

  // 打开当日日记
  async openToday() {
    if (this.shouldBlockFocusLayoutSideEffects({ source:"user" })) return;
    const f = await this.ensureTodayFile();
    await this.app.workspace.getLeaf(true).openFile(f);
  }
  // 打开当前选择的项目文件
  async openCurrentProject() {
    if (this.shouldBlockFocusLayoutSideEffects({ source:"user" })) return;
    const p = (this.settings.currentProjectPath || "").trim();
    if (!p) { new Notice("未选择项目"); return; }
    const projectRepository = this._getProjectRepository();
    const f = projectRepository.getFile(p);
    if (!projectRepository.isFile(f)) { new Notice("项目文件不存在"); return; }
    await this.app.workspace.getLeaf(true).openFile(f);
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
