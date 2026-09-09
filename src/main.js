// Pomodoro AIO 源码。项目根目录的 main.js 由 esbuild 生成，请勿直接编辑。
// 变更点：项目下拉在任务上方；项目下拉后有“打开项目”；右上角新增“打开当日日记”按钮；左侧 Ribbon 加图标。

const {
  Plugin, Notice, TFile, getFrontMatterInfo, parseYaml, normalizePath, requestUrl
} = require('obsidian');
const {
  parseHHMMToMinutes,
  positiveNumber,
  formatTomatoNumber,
  isValidHHMM,
  normalizeTomatoValue,
  normalizeMarkdownPath
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
const { RUNTIME_EVENT, RUNTIME_EFFECT, reduceRuntime } = require("./core/state-machine");
const {
  buildNextStageTransition,
  buildDailySettlementPlan,
  buildSettlementJournal,
  validateSettlementJournal
} = require("./core/settlement");
const { RuntimeStore, cloneValue } = require("./services/runtime-store");
const { DailyRepository, ProjectRepository } = require("./services/repositories");
const { ComplementarityAdvisor } = require("./services/complementarity-advisor");
const { PomodoroView } = require("./ui/pomodoro-view");
const { PomodoroSettingTab } = require("./ui/settings-tab");
const { WorkspacesPlusAdapter, workspaceLayoutLabel } = require("./integrations/workspaces-plus");
/** @typedef {import("../types/contracts").Attention} Attention */
/** @typedef {import("../types/contracts").BreakTransition} BreakTransition */
/** @typedef {import("../types/contracts").BreakContinuation} BreakContinuation */
/** @typedef {import("../types/contracts").ProjectSettlementPlan} ProjectSettlementPlan */
/** @typedef {import("../types/contracts").Runtime} Runtime */
/** @typedef {import("../types/contracts").RuntimeEvent} RuntimeEvent */
/** @typedef {import("../types/contracts").Settings} Settings */
/** @typedef {import("../types/contracts").SettlementJournal} SettlementJournal */
/** @typedef {import("../types/contracts").StageTransition} StageTransition */
/** @typedef {import("../types/contracts").TimerStage} TimerStage */
/** @typedef {Record<string, any>} AnyRecord */
/** @typedef {{suppressNotify?:boolean, cause?:string, minutes?:number|null, cycle?:boolean, cycleSlot?:0|1, taskName?:string, durationMs?:number, allowTransition?:boolean, allowPendingSettlement?:boolean, allowPendingBreakTransition?:boolean, newCycle?:boolean}} StartFocusOptions */
/** @typedef {{forceRun?:boolean, suppressNotify?:boolean, cause?:string, durationMs?:number, allowTransition?:boolean, allowPendingSettlement?:boolean, allowPendingBreakTransition?:boolean, breakContinuation?:BreakContinuation}} StartBreakOptions */
/** @typedef {{type?:string, isLong?:boolean, cycleSlot?:number|null, autoStarted?:boolean, durationMs?:number, taskName?:string}} NextPhase */

/* ========== 默认设置 ========== */
/** @type {Settings} */
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

  // 循环工作：两项任务交替；可选地在若干完整 A→B 轮次后提示短休
  workMode: "standard",
  cycleTaskA: "",
  cycleMinA: 15,
  cycleWorkspaceCommandA: "",
  cycleTaskB: "",
  cycleMinB: 15,
  cycleWorkspaceCommandB: "",
  cycleBreakEvery: 0,

  // AI 异质性顾问：使用用户配置的 OpenAI 兼容 Chat Completions 接口
  aiAdvisorEndpoint: "",
  aiAdvisorApiKey: "",
  aiAdvisorModel: "",

  // 兼容性
  respectModalInputFocus: true
};

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
/** @param {Settings} settings @returns {Runtime} */
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
    pendingBreakTransition: null,
    breakContinuation: null,
    cycleRoundCount: 0,
    quarantinedSettlement: null,
    projectQueue: [],
    frontmatterQueue: [],
    sessionCount: 0,
    currentTaskName: settings.defaultTaskName || "",
    longFocusMinutes: Math.max(0.1, Number(settings.longFocusDefaultMin) || Number(settings.focusMin) || 25),
    dayKey: "",
    viewWasOpen: false
  };
}
/** @param {Record<string, any>} [raw] @param {Settings} [fallback] @returns {Settings} */
function normalizeSettings(raw={}, fallback=DEFAULT_SETTINGS) {
  const base = Object.assign({}, DEFAULT_SETTINGS, fallback || {});
  const source = raw || {};
  const result = Object.assign({}, base, source, { schemaVersion: TIMER_SCHEMA_VERSION });
  const has = (/** @type {string} */ key) => Object.prototype.hasOwnProperty.call(source, key);
  const number = (/** @type {keyof Settings} */ key, min=0.1) => {
    const fallbackValue = positiveNumber(base[key], DEFAULT_SETTINGS[key], min);
    return has(String(key)) ? positiveNumber(source[key], fallbackValue, min) : fallbackValue;
  };
  const integer = (/** @type {keyof Settings} */ key, min=1) => {
    const fallbackValue = Math.max(min, Math.round(Number(base[key]) || min));
    const value = Number(source[key]);
    return has(String(key)) && Number.isFinite(value) && value >= min ? Math.round(value) : fallbackValue;
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
  const cycleBreakEveryFallback = Number.isFinite(Number(base.cycleBreakEvery)) && Number(base.cycleBreakEvery) >= 0
    ? Math.round(Number(base.cycleBreakEvery)) : 0;
  const cycleBreakEveryValue = Number(source.cycleBreakEvery);
  result.cycleBreakEvery = has("cycleBreakEvery") && Number.isFinite(cycleBreakEveryValue) && cycleBreakEveryValue >= 0
    ? Math.round(cycleBreakEveryValue) : cycleBreakEveryFallback;
  if (!has("cycleBreakEvery") && has("cycleBreakEnabled")) result.cycleBreakEvery = source.cycleBreakEnabled === true ? 1 : 0;
  delete result.cycleBreakEnabled;
  for (const key of ["aiAdvisorEndpoint", "aiAdvisorApiKey", "aiAdvisorModel"]) {
    result[key] = String(has(key) ? source[key] : base[key] || "").trim();
  }
  result.dayStartHHMM = has("dayStartHHMM") && isValidHHMM(source.dayStartHHMM)
    ? source.dayStartHHMM : (isValidHHMM(base.dayStartHHMM) ? base.dayStartHHMM : DEFAULT_SETTINGS.dayStartHHMM);
  result.workMode = source.workMode === "cycle" || (!has("workMode") && base.workMode === "cycle") ? "cycle" : "standard";
  result.soundWaveform = ["sine", "square", "triangle"].includes(source.soundWaveform)
    ? source.soundWaveform : base.soundWaveform;
  const fallbackPattern = tryNormalizeMarkdownPath(base.fallbackPattern) || DEFAULT_SETTINGS.fallbackPattern;
  result.fallbackPattern = has("fallbackPattern")
    ? (tryNormalizeMarkdownPath(source.fallbackPattern) || fallbackPattern)
    : fallbackPattern;
  const projectPath = has("currentProjectPath") ? source.currentProjectPath : base.currentProjectPath;
  result.currentProjectPath = String(projectPath || "").trim()
    ? (tryNormalizeMarkdownPath(projectPath) || "")
    : "";
  for (const key of ["autoNext", "projectEnable", "showProjectSelector", "enableSound", "enableNotify", "persistentAlertSound", "ribbonClickAutoNext", "allowCreateDaily", "allowAutoCreateTask", "respectModalInputFocus"]) {
    if (typeof source[key] !== "boolean") result[key] = base[key];
  }
  return result;
}
/** @param {unknown} value @param {Settings} settings @returns {Attention | null} */
function normalizeAttention(value, settings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = /** @type {AnyRecord} */ (value);
  if (![TIMER_STAGE.FOCUS, TIMER_STAGE.BREAK].includes(record.type)) return null;
  const cycleSlot = Number.isInteger(record.cycleSlot) ? (record.cycleSlot === 1 ? 1 : 0) : null;
  const durationMs = Math.max(1, Number(record.durationMs) || configuredStageDurationMs(settings, record.type, !!record.isLong, cycleSlot));
  /** @type {Attention} */
  const result = {
    type: record.type,
    isLong: !!record.isLong,
    cycleSlot,
    nextStarted: !!record.nextStarted,
    durationMs
  };
  if (record.taskName !== undefined) result.taskName = String(record.taskName || "").trim();
  return result;
}
/** @param {unknown} value @returns {{journal:SettlementJournal|null, error:string|null}} */
function normalizeSettlement(value) {
  if (!value) return { journal: null, error: null };
  const error = validateSettlementJournal(value);
  if (error) return { journal: null, error };
  const journal = /** @type {SettlementJournal} */ (cloneValue(value));
  try {
    journal.daily.path = normalizeMarkdownPath(journal.daily.path, normalizePath);
    if (journal.project.path) journal.project.path = normalizeMarkdownPath(journal.project.path, normalizePath);
    return { journal, error:null };
  } catch (pathError) {
    return { journal:null, error:`journal 路径非法：${pathError instanceof Error ? pathError.message : String(pathError)}` };
  }
}
/** @param {unknown} value @returns {BreakTransition | null} */
function normalizeBreakTransition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = /** @type {AnyRecord} */ (value);
  if (record.schemaVersion !== 1 || record.status !== "break-completing") return null;
  if (typeof record.autoNext !== "boolean" || !Number.isFinite(record.durationMs) || record.durationMs <= 0) return null;
  if (!Number.isFinite(record.createdAtMs) || record.createdAtMs <= 0) return null;
  if (record.mode !== undefined && !["standard", "cycle"].includes(record.mode)) return null;
  if (record.mode === "cycle" && (![0, 1].includes(record.cycleSlot) || typeof record.taskName !== "string")) return null;
  return /** @type {BreakTransition} */ (cloneValue(record));
}
/** @param {unknown} value @returns {BreakContinuation | null} */
function normalizeBreakContinuation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = /** @type {AnyRecord} */ (value);
  if (record.mode !== "cycle" || ![0, 1].includes(record.cycleSlot) || typeof record.taskName !== "string") return null;
  if (!Number.isFinite(record.durationMs) || record.durationMs <= 0) return null;
  return {
    mode: "cycle",
    cycleSlot: record.cycleSlot === 1 ? 1 : 0,
    taskName: String(record.taskName || "").trim(),
    durationMs: Math.round(record.durationMs)
  };
}
/** @param {unknown} value @returns {AnyRecord[]} */
function normalizeProjectQueue(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const path = tryNormalizeMarkdownPath(item?.path);
    return item && typeof item === "object" && String(item.sessionId || "") && path
      ? [{ ...cloneValue(item), path }]
      : [];
  });
}
/** @param {unknown} value @returns {AnyRecord[]} */
function normalizeFrontmatterQueue(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const path = tryNormalizeMarkdownPath(item?.path);
    return item && typeof item === "object" && String(item.key || "") && path
      ? [{ ...cloneValue(item), path }]
      : [];
  });
}
/** @param {unknown} raw @param {Settings} settings @param {number} [now] @returns {Runtime} */
function normalizeRuntime(raw, settings, now=Date.now()) {
  const defaults = createRuntimeDefaults(settings);
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {AnyRecord} */ (raw) : {};
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
  const settlement = normalizeSettlement(source.pendingSettlement);
  const breakTransition = normalizeBreakTransition(source.pendingBreakTransition);
  const breakContinuation = normalizeBreakContinuation(source.breakContinuation);
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
    pendingSettlement: settlement.journal,
    pendingBreakTransition: breakTransition,
    breakContinuation,
    quarantinedSettlement: settlement.error ? {
      sessionId: String(source.pendingSettlement?.sessionId || "") || null,
      schemaVersion: Number.isFinite(source.pendingSettlement?.schemaVersion) ? source.pendingSettlement.schemaVersion : null,
      atMs: now,
      error: settlement.error
    } : (source.quarantinedSettlement && typeof source.quarantinedSettlement === "object" ? cloneValue(source.quarantinedSettlement) : null),
    projectQueue: normalizeProjectQueue(source.projectQueue),
    frontmatterQueue: normalizeFrontmatterQueue(source.frontmatterQueue),
    sessionCount: Math.max(0, Math.floor(Number(source.sessionCount) || 0)),
    cycleRoundCount: Math.max(0, Math.floor(Number(source.cycleRoundCount) || 0)),
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
    result.breakContinuation = null;
    result.cycleRoundCount = 0;
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
    result.breakContinuation = result.attention?.type === TIMER_STAGE.BREAK ? breakContinuation : null;
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
    result.breakContinuation = null;
    result.cycleRoundCount = 0;
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
  if (result.stage !== TIMER_STAGE.BREAK && result.attention?.type !== TIMER_STAGE.BREAK && !result.pendingBreakTransition) result.breakContinuation = null;
  if (result.status === TIMER_STATUS.SETTLING && !result.pendingSettlement && !result.pendingBreakTransition) {
    result.status = TIMER_STATUS.FAILED;
    result.failure = { stage: result.stage, sessionId: result.sessionId || null, atMs: now, message: "转换状态缺少 journal" };
  }
  if ([TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED].includes(result.status)) result.attention = null;
  if (result.stage === TIMER_STAGE.FOCUS && result.status !== TIMER_STATUS.AWAITING) result.plannedTomatoCredit = plannedTomatoAmount(result.durationMs);
  if (result.stage === TIMER_STAGE.BREAK) result.plannedTomatoCredit = 0;
  if (settlement.error) {
    result.status = TIMER_STATUS.FAILED;
    result.stage = null;
    result.durationMs = 0;
    result.startedAtMs = 0;
    result.elapsedMs = 0;
    result.remainingMs = 0;
    result.pausedAtMs = 0;
    result.sessionId = null;
    result.plannedTomatoCredit = 0;
    result.attention = null;
    result.failure = {
      operation: "quarantineSettlement",
      sessionId: result.quarantinedSettlement.sessionId,
      stage: TIMER_STAGE.FOCUS,
      target: null,
      step: "validate",
      atMs: now,
      message: `无效结算 journal 已隔离：${settlement.error}`
    };
  }
  return result;
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
    /** @type {InstanceType<typeof ComplementarityAdvisor> | null} */
    this.complementarityAdvisor = null;
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
    this._unloading = false;
    this._scheduleTick = () => {};
  }
  async onload() {
    this._lastPersistenceError = null;
    await this.loadSettings();
    this.runtime = normalizeRuntime(await this.loadState(), this.settings);
    this._alertInterval = null;
    this._alertEscalationTimeout = null;
    this._completionInFlight = false;
    this.ribbonBadge = null;
    if (!this.runtime.dayKey) this.runtime = reduceRuntime(this.runtime, {
      type:RUNTIME_EVENT.DAY_ROLLOVER,
      dayKey:this.logicalTodayKey()
    }).runtime;
    await this.saveState({ critical:true });
    await this.recoverPendingSettlement();
    await this.recoverPendingBreakTransition();
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
        this.runUserCommand(() => this.onRibbonClick(), evt);
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
    try {
      await this.saveState({ critical:true });
    } catch (error) {
      this.runtime = previousRuntime;
      this.applyStrongAlertStateFromRuntime();
      this.broadcast();
      this._resyncTick();
      throw error;
    }
  }
  /** @param {RuntimeEvent} event */
  applyRuntimeEvent(event){
    const transition = reduceRuntime(this.runtime, event);
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
    this.settings = normalizeSettings(data || {});
    return this.settings;
  }
  async saveSettings(){
    return this._getRuntimeStore().saveSettings(this.settings);
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
        ".quick-switcher", ".command-palette", ".mod-command-palette"
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
  /** @param {{source?:string}} [opts] */
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
    if (!this.settings.ribbonClickAutoNext || this.runtime.attention.nextStarted) {
      await this.stopStrongAlert();
      return;
    }
    await this.startPendingStage();
  }
  async startPendingStage(){
    const next = this.runtime.attention;
    if (!next || next.nextStarted) { await this.stopStrongAlert(); return; }
    if (next.type === TIMER_STAGE.BREAK) await this.startBreak(next.isLong, {
      forceRun:true,
      cause:'manual',
      durationMs:next.durationMs,
      allowTransition:true,
      breakContinuation:this.runtime.breakContinuation || undefined
    });
    else if (next.type === TIMER_STAGE.FOCUS && Number.isInteger(next.cycleSlot)) {
      /** @type {StartFocusOptions} */
      const options = { cause:'manual', durationMs:next.durationMs, allowTransition:true };
      if (next.taskName !== undefined) options.taskName = next.taskName;
      await this.startCycle(next.cycleSlot === 1 ? 1 : 0, options);
    }
    else if (next.type === TIMER_STAGE.FOCUS) await this.startFocus({ cause:'manual', durationMs:next.durationMs, allowTransition:true });
    else await this.stopStrongAlert();
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
      durationMs: Math.max(1, Number(nextPhase?.durationMs) || configuredStageDurationMs(this.settings, stage, !!nextPhase?.isLong, cycleSlot))
    };
    if (nextPhase?.taskName !== undefined) attention.taskName = String(nextPhase.taskName || "").trim();
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
    const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
    return `${task ? `完成：${task} · ` : ""}+${formatTomatoNumber(tomatoAmount)}🍅\n下一步：${next}`;
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
  /** @param {boolean | StartFocusOptions} [options] */
  async startFocus(options){
    /** @type {StartFocusOptions} */
    let opts = { suppressNotify:false, cause:'manual', minutes:null, cycle:false };
    if (typeof options === 'boolean') opts.suppressNotify = options;
    else if (options && typeof options === 'object') opts = Object.assign(opts, options);
    if (this.runtime.pendingSettlement && !opts.allowPendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    if (this.runtime.pendingBreakTransition && !opts.allowPendingBreakTransition) {
      new Notice("休息转换待恢复，请重载插件或重置");
      return false;
    }
    if (!opts.allowTransition && (this.runtime.status !== TIMER_STATUS.IDLE || this.runtime.attention)) {
      new Notice("当前已有计时，请先完成或重置当前阶段");
      return false;
    }
    const previousRuntime = this.runtime;
    this.ensureDayFreshness(false);
    const requestedDurationMs = Number(opts.durationMs);
    const durationMs = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0 ? Math.round(requestedDurationMs) : 0;
    const minutesRaw = typeof opts.minutes === 'number' && isFinite(opts.minutes) && opts.minutes > 0 ? opts.minutes : (this.settings.focusMin || 25);
    const minutes = durationMs ? durationMs / 60_000 : Math.max(0.1, minutesRaw);
    const effects = this.applyRuntimeEvent({
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
    await this.saveTransition(previousRuntime);
    this.runRuntimeEffects(effects);
    playBeep(this.settings.focusStartSound, this.settings.enableSound, this.settings.soundWaveform);
    if (!opts.suppressNotify) {
      const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
      sysNotify("开始专注", `${formatTomatoNumber(minutes)} 分钟${task ? ` · 任务：${task}` : ""}`, this.settings.enableNotify);
    }
    const commandId = opts.cycle
      ? (this.runtime.cycleSlot === 1 ? this.settings.cycleWorkspaceCommandB : this.settings.cycleWorkspaceCommandA)
      : this.settings.focusStartCommandId;
    if (opts.cause !== 'auto' && commandId) this.executeStageCommand(commandId);
  }
  /** @param {number} [slot] @param {StartFocusOptions} [options] */
  async startCycle(slot=this.runtime.cycleSlot, options={}){
    if (this.runtime.pendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    if (this.runtime.pendingBreakTransition) {
      new Notice("休息转换待恢复，请重载插件或重置");
      return false;
    }
    if (!options?.allowTransition && (this.runtime.status !== TIMER_STATUS.IDLE || this.runtime.attention)) {
      new Notice("当前已有计时，请先完成或重置当前阶段");
      return false;
    }
    const cycleSlot = slot === 1 ? 1 : 0;
    const newCycle = !options?.allowTransition && this.runtime.status === TIMER_STATUS.IDLE && !this.runtime.attention;
    const hasTaskSnapshot = Object.prototype.hasOwnProperty.call(options || {}, "taskName");
    const configuredTask = cycleSlot ? this.settings.cycleTaskB : this.settings.cycleTaskA;
    const task = String(hasTaskSnapshot ? options.taskName : configuredTask || "").trim();
    const requestedDurationMs = Number(options?.durationMs);
    const minutes = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0
      ? requestedDurationMs / 60_000
      : Number(cycleSlot ? this.settings.cycleMinB : this.settings.cycleMinA);
    if (!task) { new Notice(`请先填写任务 ${cycleSlot ? "B" : "A"}`); return; }
    if (!isFinite(minutes) || minutes <= 0) { new Notice(`请设置任务 ${cycleSlot ? "B" : "A"} 的时长`); return; }
    return this.startFocus(Object.assign({ cause:'manual' }, options, { minutes, cycle:true, cycleSlot, taskName:task, newCycle }));
  }
  /** @param {boolean} [isLong] @param {boolean | StartBreakOptions} [options] */
  async startBreak(isLong=false, options){
    /** @type {StartBreakOptions} */
    let opts = { forceRun:true, suppressNotify:false, cause:'manual' };
    if (typeof options === 'boolean') opts.forceRun = options;
    else if (options && typeof options === 'object') opts = Object.assign(opts, options);
    if (this.runtime.pendingSettlement && !opts.allowPendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    if (this.runtime.pendingBreakTransition && !opts.allowPendingBreakTransition) {
      new Notice("休息转换待恢复，请重载插件或重置");
      return false;
    }
    if (!opts.allowTransition && (this.runtime.status !== TIMER_STATUS.IDLE || this.runtime.attention)) {
      new Notice("当前已有计时，请先完成或重置当前阶段");
      return false;
    }
    const previousRuntime = this.runtime;
    this.ensureDayFreshness(false);
    const requestedDurationMs = Number(opts.durationMs);
    const durationMs = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0
      ? Math.round(requestedDurationMs)
      : Math.max(1, Math.round((isLong ? (this.settings.longBreakMin||15) : (this.settings.breakMin||5)) * 60 * 1000));
    const minutes = durationMs / 60_000;
    const forceRun = opts.forceRun ?? true;
    const shouldRun = forceRun !== false && (forceRun || !!this.settings.autoNext);
    const continuation = normalizeBreakContinuation(opts.breakContinuation);
    const effects = this.applyRuntimeEvent(shouldRun ? {
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
    await this.saveTransition(previousRuntime);
    this.runRuntimeEffects(effects);
    playBeep(this.settings.breakStartSound, this.settings.enableSound, this.settings.soundWaveform);
    if (!opts.suppressNotify) {
      const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
      sysNotify("开始休息", `${formatTomatoNumber(minutes)} 分钟${task ? ` · 刚完成：${task}` : ""}`, this.settings.enableNotify);
    }
    if (opts.cause !== 'auto' && this.settings.breakStartCommandId) this.executeStageCommand(this.settings.breakStartCommandId);
  }
  /** @param {boolean} [triggerCommand] */
  async togglePause(triggerCommand=false){
    const r = this.runtime;
    if (!/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(r.status)) return false;
    const previousRuntime = this.runtime;
    this.ensureDayFreshness(false);
    const wasPaused = r.status === TIMER_STATUS.PAUSED;
    let effects;
    if (!wasPaused){
      const now = Date.now();
      const elapsedMs = this.getElapsedMs(now);
      if (elapsedMs >= r.durationMs) {
        await (r.stage === TIMER_STAGE.FOCUS ? this.settleFocus(false) : this.settleBreak());
        return false;
      }
      effects = this.applyRuntimeEvent({ type:RUNTIME_EVENT.PAUSE, now, elapsedMs });
    } else {
      effects = this.applyRuntimeEvent({ type:RUNTIME_EVENT.RESUME, now:Date.now() });
    }
    await this.saveTransition(previousRuntime);
    this.runRuntimeEffects(effects);
    const current = this.runtime;
    if (triggerCommand && wasPaused && current.status === TIMER_STATUS.RUNNING) {
      const focusCommandId = current.mode === 'cycle'
        ? (current.cycleSlot === 1 ? this.settings.cycleWorkspaceCommandB : this.settings.cycleWorkspaceCommandA)
        : this.settings.focusStartCommandId;
      if (current.stage === TIMER_STAGE.FOCUS && focusCommandId) this.executeStageCommand(focusCommandId);
      else if (current.stage === TIMER_STAGE.BREAK && this.settings.breakStartCommandId) this.executeStageCommand(this.settings.breakStartCommandId);
    }
    return true;
  }
  /** @param {boolean} [showNotice] */
  async reset(showNotice=true){
    if (this.runtime.pendingSettlement) {
      new Notice("存在未完成结算，请先重载插件恢复");
      return false;
    }
    const previousRuntime = this.runtime;
    this.ensureDayFreshness(false);
    const effects = this.applyRuntimeEvent({
      type:RUNTIME_EVENT.RESET,
      mode:this.settings.workMode === 'cycle' ? 'cycle' : 'standard'
    });
    await this.saveTransition(previousRuntime);
    this.runRuntimeEffects(effects);
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
    if (!/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(this.runtime.status) || this.runtime.stage !== TIMER_STAGE.FOCUS) {
      new Notice("当前不在专注阶段"); return;
    }
    if (this._completionInFlight) { new Notice("正在结算当前专注"); return; }
    if (this.getElapsedMs() <= 0) { new Notice("尚未产生有效专注时长"); return; }
    await this.settleFocus(true);
  }

  /** @param {boolean} [manual] */
  async settleFocus(manual=false){
    const r = this.runtime;
    if (this._completionInFlight || !/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(r.status) || r.stage !== TIMER_STAGE.FOCUS) return;
    this._completionInFlight = true;
    const elapsedMs = this.getElapsedMs();
    const tomatoAmount = manual ? actualTomatoAmount(elapsedMs) : plannedTomatoAmount(r.durationMs);
    const settlementEffects = this.applyRuntimeEvent({
      type:RUNTIME_EVENT.BEGIN_FOCUS_SETTLEMENT,
      sessionId:r.sessionId || createSessionId()
    });
    try {
      const current = this.runtime;
      if (!current.pendingSettlement || current.pendingSettlement.sessionId !== current.sessionId) {
        const sessionCountAfter = (current.sessionCount || 0) + 1;
        const transition = buildNextStageTransition(this.settings, current, sessionCountAfter);
        const journal = await this.prepareSettlement(tomatoAmount, transition, sessionCountAfter, manual);
        this.applyRuntimeEvent({ type:RUNTIME_EVENT.SET_PENDING_SETTLEMENT, journal });
        await this.saveState({ critical:true });
      }
      this.runRuntimeEffects(settlementEffects);
      await this.resumePendingSettlement();
    } catch (error) {
      this.markSettlementFailed(error, { operation:"settleFocus", step:"prepareOrResume" });
    } finally {
      this._completionInFlight = false;
    }
  }
  /** @param {number} amount @param {StageTransition} transition @param {number} sessionCountAfter @param {boolean} [manual] @returns {Promise<SettlementJournal>} */
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
      sessionId: this.runtime.sessionId || createSessionId(),
      durationMs: this.runtime.durationMs,
      taskName,
      amount,
      manual,
      sessionCountAfter,
      transition,
      createdAtMs: Date.now(),
      daily,
      project: await this.prepareProjectSettlement(amount)
    });
  }
  /** @param {number} amount */
  prepareProjectSettlement(amount){
    return this._getProjectRepository().prepareSettlementPlan({
      path: this.settings.currentProjectPath,
      key: this.settings.projectFmKey,
      amount,
      enabled: this.settings.projectEnable
    });
  }
  /** @param {SettlementJournal} journal */
  async applyDailySettlement(journal){
    const daily = journal.daily;
    if (!daily || !daily.path) throw new Error("结算 journal 缺少日记写入计划");
    const dailyRepository = this._getDailyRepository();
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
          settings:{ ...this.settings, allowAutoCreateTask:true, tasksHeading:daily.heading || "" }
        });
        Object.assign(daily, rebased);
        await this.saveState({ critical:true });
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
        await dailyRepository.processFrontMatter(file, fm=>{ fm[daily.frontmatterKey] = daily.expectedSum; });
        daily.frontmatterStatus = "applied";
        this.removeFrontmatterRepair(daily.path, daily.frontmatterKey);
      } catch (error) {
        daily.frontmatterStatus = "pending";
        daily.frontmatterError = String(error instanceof Error ? error.message : error);
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
  /** @param {ProjectSettlementPlan} plan */
  async applyProjectPlan(plan){
    return this._getProjectRepository().applyPlan(plan);
  }
  /** @param {SettlementJournal} journal */
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
  /** @param {AnyRecord} item */
  upsertProjectRetry(item){
    const queue = this.runtime.projectQueue || (this.runtime.projectQueue = []);
    const copy = cloneValue(item);
    const index = queue.findIndex(entry=> entry.sessionId === copy.sessionId && entry.path === copy.path);
    if (index === -1) queue.push(copy);
    else queue[index] = copy;
  }
  /** @param {unknown} sessionId @param {unknown} path */
  removeProjectRetry(sessionId, path){
    this.runtime.projectQueue = (this.runtime.projectQueue || []).filter(item=> !(item.sessionId === sessionId && item.path === path));
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
    const queue = this.runtime.frontmatterQueue || (this.runtime.frontmatterQueue = []);
    const copy = cloneValue(item);
    const index = queue.findIndex(entry=> entry.sessionId === copy.sessionId && entry.path === copy.path && entry.key === copy.key);
    if (index === -1) queue.push(copy);
    else queue[index] = copy;
  }
  /** @param {unknown} path @param {unknown} key @param {unknown} [sessionId] */
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
        item.error = String(error instanceof Error ? error.message : error);
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
        result = await this.applyProjectPlan(/** @type {ProjectSettlementPlan} */ (item));
      } catch (error) {
        result = { status: "pending", error: String(error instanceof Error ? error.message : error) };
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
  /** @param {SettlementJournal} journal */
  async finalizeFocusSettlement(journal){
    this.applyRuntimeEvent({ type:RUNTIME_EVENT.FINALIZE_SETTLEMENT, journal });
    journal.status = "runtimeFinalizing";
    await this.saveState({ critical:true });

    if (!journal.notified) {
      playBeep(this.settings.focusEndSound, this.settings.enableSound, this.settings.soundWaveform);
      if (journal.transition.mode === "cycle") {
        const nextTask = Object.prototype.hasOwnProperty.call(journal.transition, "taskName")
          ? String(journal.transition.taskName || "").trim()
          : String((journal.transition.cycleSlot === 1 ? this.settings.cycleTaskB : this.settings.cycleTaskA) || "").trim();
        const cycleRestDurationMs = Math.max(0, Number(journal.transition.cycleRestDurationMs) || 0);
        const next = cycleRestDurationMs
          ? `本轮完成，短休 ${formatTomatoNumber(cycleRestDurationMs / 60_000)} 分钟（点击番茄图标开始）`
          : `${nextTask || "下一段专注"}（点击番茄图标开始）`;
        sysNotify(journal.manual ? "专注完成（手动）" : "专注完成", this.focusCompletionBody(journal.amount, next), this.settings.enableNotify);
      } else {
        const breakMinutes = journal.transition.durationMs / 60 / 1000;
        sysNotify(journal.manual ? "专注完成（手动）" : "专注完成", this.focusCompletionBody(journal.amount, `${journal.transition.isLong ? "长休" : "短休"} ${formatTomatoNumber(breakMinutes)} 分钟${journal.transition.autoNext ? "（已开始）" : "（点击番茄图标开始）"}`), this.settings.enableNotify);
      }
      journal.notified = true;
      await this.saveState({ critical:true });
    }

    if (journal.transition.mode === "cycle") {
      const r = this.runtime;
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
          this.applyRuntimeEvent({
            type:RUNTIME_EVENT.AWAIT_STAGE,
            durationMs: cycleRestDurationMs,
            mode:"cycle",
            cycleSlot:continuation.cycleSlot,
            breakContinuation:continuation
          });
          await this.beginStrongAlert({
            type:TIMER_STAGE.BREAK,
            isLong:false,
            autoStarted:false,
            durationMs:cycleRestDurationMs,
            cycleSlot:continuation.cycleSlot,
            taskName:continuation.taskName
          });
        } else if (existingRest && r.status === TIMER_STATUS.SETTLING) {
          this.applyRuntimeEvent({ type:RUNTIME_EVENT.RESTORE_ACTIVE_STAGE });
          await this.beginStrongAlert({
            type:TIMER_STAGE.BREAK,
            isLong:false,
            autoStarted:true,
            durationMs:cycleRestDurationMs,
            cycleSlot:continuation.cycleSlot,
            taskName:continuation.taskName
          });
        } else if (existingRest && !r.attention) {
          await this.beginStrongAlert({
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
          this.applyRuntimeEvent({
            type:RUNTIME_EVENT.AWAIT_STAGE,
            durationMs:journal.transition.durationMs,
            mode:"cycle",
            cycleSlot:journal.transition.cycleSlot
          });
          await this.beginStrongAlert({ type:TIMER_STAGE.FOCUS, cycleSlot:journal.transition.cycleSlot, taskName:journal.transition.taskName, autoStarted:false, durationMs:journal.transition.durationMs });
        }
      }
    } else {
      const r = this.runtime;
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
        await this.startBreak(journal.transition.isLong, {
          forceRun: journal.transition.autoNext,
          cause: journal.manual ? "manual" : "auto",
          suppressNotify: true,
          durationMs: journal.transition.durationMs,
          allowTransition: true,
          allowPendingSettlement: true
        });
      } else if (existingBreak && r.status === TIMER_STATUS.SETTLING) {
        this.applyRuntimeEvent({ type:RUNTIME_EVENT.RESTORE_ACTIVE_STAGE });
      }
      await this.beginStrongAlert({
        type:TIMER_STAGE.BREAK,
        isLong:journal.transition.isLong,
        autoStarted:journal.transition.autoNext,
        durationMs:journal.transition.durationMs
      });
    }
    journal.status = "settled";
    await this.saveState({ critical:true });
    const effects = this.applyRuntimeEvent({ type:RUNTIME_EVENT.CLEAR_PENDING_SETTLEMENT });
    await this.saveState({ critical:true });
    this.runRuntimeEffects(effects);
  }
  async resumePendingSettlement(){
    const journal = this.runtime.pendingSettlement;
    if (!journal) return;
    const effects = this.applyRuntimeEvent({ type:RUNTIME_EVENT.RESUME_SETTLEMENT, journal });
    this.runRuntimeEffects(effects);
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
  /** @param {BreakTransition} transition */
  async advanceBreakTransition(transition){
    const r = this.runtime;
    const isCycle = transition.mode === "cycle";
    const focusStarted = transition.autoNext
      && r.stage === TIMER_STAGE.FOCUS
      && Math.round(Number(r.durationMs) || 0) === Math.round(transition.durationMs)
      && (/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.FAILED]).includes(r.status) && Number(r.startedAtMs) > 0
        || /** @type {string[]} */ ([TIMER_STATUS.PAUSED, TIMER_STATUS.FAILED]).includes(r.status) && Number(r.pausedAtMs) > 0 && Number(r.remainingMs) > 0);
    if (focusStarted && r.status === TIMER_STATUS.FAILED) {
      this.applyRuntimeEvent({ type:RUNTIME_EVENT.RESTORE_FOCUS });
    }
    if (transition.autoNext && !focusStarted) {
      if (isCycle && Number.isInteger(transition.cycleSlot)) {
        await this.startCycle(transition.cycleSlot === 1 ? 1 : 0, {
          suppressNotify:true,
          cause:'auto',
          allowTransition:true,
          allowPendingBreakTransition:true,
          durationMs:transition.durationMs,
          taskName:transition.taskName
        });
      } else {
        await this.startFocus({
          suppressNotify:true,
          cause:'auto',
          allowTransition:true,
          allowPendingBreakTransition:true,
          durationMs:transition.durationMs
        });
      }
    }
    await this.beginStrongAlert({
      type:TIMER_STAGE.FOCUS,
      autoStarted:transition.autoNext,
      durationMs:transition.durationMs,
      cycleSlot:isCycle && Number.isInteger(transition.cycleSlot) ? transition.cycleSlot : null,
      taskName:isCycle ? transition.taskName : undefined
    });
    const previousRuntime = this.runtime;
    const effects = this.applyRuntimeEvent({ type:RUNTIME_EVENT.CLEAR_BREAK_TRANSITION });
    await this.saveTransition(previousRuntime);
    this.runRuntimeEffects(effects);
  }
  async recoverPendingBreakTransition(){
    const transition = this.runtime.pendingBreakTransition;
    if (!transition) return;
    this._completionInFlight = true;
    try {
      await this.advanceBreakTransition(transition);
    } catch (error) {
      this.markSettlementFailed(error, { operation:"recoverBreakTransition", step:"advanceFocus" });
    } finally {
      this._completionInFlight = false;
    }
  }
  async settleBreak(){
    const r = this.runtime;
    if (this._completionInFlight || r.status !== TIMER_STATUS.RUNNING || r.stage !== TIMER_STAGE.BREAK) return;
    this._completionInFlight = true;
    /** @type {BreakContinuation | null} */
    const cycleContinuation = r.breakContinuation?.mode === "cycle" ? r.breakContinuation : null;
    /** @type {BreakTransition} */
    const transition = {
      schemaVersion:1,
      status:"break-completing",
      autoNext:cycleContinuation ? false : !!this.settings.autoNext,
      durationMs:cycleContinuation
        ? cycleContinuation.durationMs
        : configuredStageDurationMs(this.settings, TIMER_STAGE.FOCUS),
      createdAtMs:Date.now()
    };
    if (cycleContinuation) {
      transition.mode = "cycle";
      transition.cycleSlot = cycleContinuation.cycleSlot;
      transition.taskName = cycleContinuation.taskName;
    }
    const effects = this.applyRuntimeEvent({ type:RUNTIME_EVENT.BEGIN_BREAK_TRANSITION, transition });
    try {
      await this.saveState({ critical:true });
      this.runRuntimeEffects(effects);
      playBeep(this.settings.breakEndSound, this.settings.enableSound, this.settings.soundWaveform);
      const task = transition.mode === "cycle"
        ? String(transition.taskName || "").trim()
        : String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
      sysNotify("休息结束", `下一步：${transition.autoNext ? "已开始" : "点击番茄图标开始"}专注${task ? ` · 任务：${task}` : ""}`, this.settings.enableNotify);
      await this.advanceBreakTransition(transition);
    } catch (error) {
      this.markSettlementFailed(error, { operation:"settleBreak", step:"advanceFocus" });
    } finally {
      this._completionInFlight = false;
    }
  }
  /** @param {unknown} error @param {{operation?:string, sessionId?:string|null, stage?:string|null, target?:string|null, step?:string|null}} [context] */
  markSettlementFailed(error, context={}){
    const r = this.runtime;
    const details = logPluginError(context.operation || "settlement", error, {
      ...context,
      sessionId: context.sessionId || r.sessionId || r.pendingSettlement?.sessionId,
      stage: context.stage || r.stage || r.pendingSettlement?.stage,
      target: context.target || r.pendingSettlement?.daily?.path || r.pendingSettlement?.project?.path
    });
    const effects = this.applyRuntimeEvent({ type:RUNTIME_EVENT.FAIL, failure:{
      ...details,
      atMs: Date.now(),
      message: details.error
    } });
    this.saveState();
    this.runRuntimeEffects(effects);
    new Notice("结算失败，journal 已保留，请重载插件恢复");
  }

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
        error: String(result.frontmatterError instanceof Error ? result.frontmatterError.message : result.frontmatterError)
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
  _getComplementarityAdvisor(){
    if (!this.complementarityAdvisor) this.complementarityAdvisor = new ComplementarityAdvisor({ requestUrl });
    return this.complementarityAdvisor;
  }
  /** @param {unknown} taskA @param {unknown} taskB */
  async assessTaskHeterogeneity(taskA, taskB){
    return this._getComplementarityAdvisor().assess({
      endpoint:this.settings.aiAdvisorEndpoint,
      apiKey:this.settings.aiAdvisorApiKey,
      model:this.settings.aiAdvisorModel
    }, taskA, taskB);
  }
  /** @param {unknown} name */
  setCurrentTaskName(name){
    const effects = this.applyRuntimeEvent({ type:RUNTIME_EVENT.SET_TASK, name });
    this.saveState();
    this.runRuntimeEffects(effects);
  }
  /** @param {unknown} open */
  setViewWasOpen(open){
    this.applyRuntimeEvent({ type:RUNTIME_EVENT.SET_VIEW_OPEN, open });
    this.saveState();
  }
  /** @param {unknown} path */
  setCurrentProjectPath(path){
    const rawPath = String(path||"").trim();
    const projectPath = rawPath ? tryNormalizeMarkdownPath(rawPath) : "";
    if (rawPath && !projectPath) { new Notice("项目路径无效"); return false; }
    this.settings.currentProjectPath = projectPath || "";
    this.saveSettings(); this.broadcast();
    return true;
  }
  /** @param {unknown} mode */
  setWorkMode(mode){
    if (this.runtime.status !== TIMER_STATUS.IDLE || this.runtime.attention) { new Notice("请先重置当前计时，再切换工作模式"); return false; }
    this.settings = normalizeSettings({ ...this.settings, workMode: mode === 'cycle' ? 'cycle' : 'standard' }, this.settings);
    this.saveSettings(); this.broadcast();
    return true;
  }
  /** @param {Partial<Settings>} patch */
  setCycleConfig(patch){
    this.settings = normalizeSettings({ ...this.settings, ...patch }, this.settings);
    this.saveSettings(); this.broadcast();
  }
  /** @param {unknown} slot */
  selectCycleSlot(slot){
    if (this.settings.workMode !== 'cycle' || this.runtime.status !== TIMER_STATUS.IDLE || this.runtime.attention) return false;
    const effects = this.applyRuntimeEvent({ type:RUNTIME_EVENT.SELECT_CYCLE_SLOT, slot });
    this.saveState();
    this.runRuntimeEffects(effects);
    return true;
  }
  /** @param {unknown} minutes @param {boolean} [broadcast] */
  setLongFocusMinutes(minutes, broadcast=true){
    const num = Number(minutes);
    if (!isFinite(num)) return;
    const normalized = Math.max(0.1, Math.round(num * 10) / 10);
    const effects = this.applyRuntimeEvent({ type:RUNTIME_EVENT.SET_LONG_FOCUS, minutes:normalized, broadcast });
    if (broadcast) {
      this.saveState();
      this.runRuntimeEffects(effects);
    }
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
    const p = this.settings.currentProjectPath;
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
