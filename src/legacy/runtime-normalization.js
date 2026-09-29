const { configuredStageDurationMs } = require("./timer");
const { normalizePath } = require("obsidian");
const { normalizeMarkdownPath } = require("../core/validation");
const { TIMER_SCHEMA_VERSION, TIMER_STATUS, TIMER_STAGE, plannedTomatoAmount, createSessionId } = require("../core/timer");
const { validateSettlementJournal } = require("./settlement-recovery");
const { cloneValue } = require("../services/runtime-store");
const { migrateLegacyRuntime } = require("./runtime-migration");
const { createRuntimeDefaults, normalizeModuleRun } = require("../core/runtime");
/** @typedef {import("../../types/legacy-contracts").LegacyAttention} Attention */
/** @typedef {import("../../types/legacy-contracts").LegacyBreakTransition} BreakTransition */
/** @typedef {import("../../types/legacy-contracts").BreakContinuation} BreakContinuation */
/** @typedef {import("../../types/contracts").Runtime} Runtime */
/** @typedef {import("../../types/contracts").Settings} Settings */
/** @typedef {import("../../types/legacy-contracts").LegacySettlementJournal} SettlementJournal */
/** @typedef {Record<string, any>} AnyRecord */
/** @param {unknown} value @returns {string | null} */
function tryNormalizeMarkdownPath(value) {
  try { return normalizeMarkdownPath(value, normalizePath); }
  catch (_) { return null; }
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
  if (Number.isInteger(record.moduleIndex) && record.moduleIndex >= 0) result.moduleIndex = record.moduleIndex;
  if (record.moduleRun) {
    const moduleRun = normalizeModuleRun(record.moduleRun);
    if (!moduleRun) return null;
    if (moduleRun) result.moduleRun = moduleRun;
  }
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
  if (record.mode !== undefined && !["standard", "cycle", "modules"].includes(record.mode)) return null;
  if (record.mode === "cycle" && (![0, 1].includes(record.cycleSlot) || typeof record.taskName !== "string")) return null;
  if (record.mode === "modules" && (record.moduleIndex !== null && (!Number.isInteger(record.moduleIndex) || record.moduleIndex < 0))) return null;
  if (record.mode === "modules" && record.moduleRun && !normalizeModuleRun(record.moduleRun)) return null;
  if (record.mode === "modules" && record.completionType === "work"
    && (!Number.isInteger(record.completedWorkCountAfter) || !Number.isInteger(record.sessionCountAfter))) return null;
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
  const mode = source.mode === "modules" || (!legacyPhase && !source.attention && (!source.status || source.status === TIMER_STATUS.IDLE))
    ? "modules" : (source.mode === "cycle" || source.cycleActive || (legacy && settings.workMode === "cycle") ? "cycle" : "standard");
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
    moduleRun:normalizeModuleRun(source.moduleRun),
    currentModuleIndex:Math.max(0, Math.floor(Number(source.currentModuleIndex) || 0)),
    selectedModuleId:String(source.selectedModuleId || "") || null,
    completedWorkCount:Math.max(0, Math.floor(Number(source.completedWorkCount) || 0)),
    completedRestCount:Math.max(0, Math.floor(Number(source.completedRestCount) || 0)),
    completedLoopCount:Math.max(0, Math.floor(Number(source.completedLoopCount) || 0)),
    cycleSlot: Number(source.cycleSlot) === 1 ? 1 : 0,
    durationMs,
    startedAtMs,
    elapsedMs,
    remainingMs,
    pausedAtMs,
    sessionId: source.sessionId || (source.moduleRun?.runId || (stage === TIMER_STAGE.FOCUS && [TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED].includes(status) ? createSessionId() : null)),
    plannedTomatoCredit: stage === TIMER_STAGE.FOCUS ? plannedTomatoAmount(durationMs || (Number(settings.focusMin) || 25) * 60 * 1000) : 0,
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
    currentTaskName: String(source.currentTaskName ?? settings.defaultTaskName ?? ""),
    longFocusMinutes: Math.max(0.1, Number(source.longFocusMinutes) || Number(settings.longFocusDefaultMin) || Number(settings.focusMin) || 25),
    dayKey: String(source.dayKey || defaults.dayKey),
    viewWasOpen: !!source.viewWasOpen,
    failure: source.failure && typeof source.failure === "object" ? source.failure : null
  });

  const moduleDefinitions = Array.isArray(settings.modules) ? settings.modules : [];
  const selectedId = result.attention?.moduleRun?.moduleId || result.moduleRun?.moduleId || result.selectedModuleId;
  const selectedIndex = moduleDefinitions.findIndex(item => item.id === selectedId);
  const fallbackIndex = Math.min(result.currentModuleIndex || 0, Math.max(0, moduleDefinitions.length - 1));
  result.selectedModuleId = moduleDefinitions[selectedIndex >= 0 ? selectedIndex : fallbackIndex]?.id || null;
  if (result.status === TIMER_STATUS.IDLE) result.currentModuleIndex = selectedIndex >= 0 ? selectedIndex : fallbackIndex;

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
    result.moduleRun = null;
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
    result.moduleRun = null;
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
    result.moduleRun = null;
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
  if (mode === "modules" && [TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED].includes(result.status) && !result.moduleRun) {
    result.status = TIMER_STATUS.FAILED;
    result.failure = { stage:result.stage, sessionId:result.sessionId, atMs:now, message:"模块执行快照缺失" };
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
  return settings.schemaVersion === TIMER_SCHEMA_VERSION
    ? /** @type {Runtime} */ (migrateLegacyRuntime(result, source, settings, now))
    : result;
}

module.exports = { createRuntimeDefaults, normalizeRuntime, normalizeModuleRun, normalizeBreakContinuation };
