const { normalizePath } = require("obsidian");
const { normalizeMarkdownPath } = require("./validation");
const { TIMER_SCHEMA_VERSION, TIMER_STATUS, TIMER_STAGE, plannedTomatoAmount } = require("./timer");
const { validateSettlementJournal } = require("./settlement");
const { cloneValue } = require("../services/runtime-store");
const { normalizeLightingSnapshot } = require("./lighting");
/** @typedef {import("../../types/contracts").Runtime} Runtime */
/** @typedef {import("../../types/contracts").Settings} Settings */
/** @typedef {import("../../types/contracts").ModuleRun} ModuleRun */
/** @typedef {Record<string, any>} AnyRecord */

/** @param {unknown} value @returns {string | null} */
function markdownPath(value) {
  try { return normalizeMarkdownPath(value, normalizePath); }
  catch (_) { return null; }
}

/** @param {Settings} settings @returns {Runtime} */
function createRuntimeDefaults(settings) {
  return {
    schemaVersion:TIMER_SCHEMA_VERSION, status:TIMER_STATUS.IDLE, stage:null, mode:"modules",
    moduleRun:null, currentModuleIndex:0, selectedModuleId:settings.modules?.[0]?.id || null,
    completedWorkCount:0, completedRestCount:0, completedLoopCount:0,
    durationMs:0, startedAtMs:0, elapsedMs:0, remainingMs:0, pausedAtMs:0,
    sessionId:null, plannedTomatoCredit:0, attention:null, pendingSettlement:null,
    pendingBreakTransition:null, quarantinedSettlement:null, projectQueue:[], frontmatterQueue:[],
    sessionCount:0, dayKey:"", viewWasOpen:false
  };
}

/** @param {unknown} value @returns {ModuleRun | null} */
function normalizeModuleRun(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const run = /** @type {AnyRecord} */ (value);
  if (!String(run.runId || "").trim() || !String(run.moduleId || "").trim()
    || !["work", "rest"].includes(run.type) || !String(run.name || "").trim()
    || !Number.isFinite(run.durationMs) || run.durationMs <= 0) return null;
  const projectPath = String(run.projectPath || "").trim();
  const normalizedProjectPath = projectPath ? markdownPath(projectPath) : "";
  if (projectPath && !normalizedProjectPath) return null;
  return {
    runId:String(run.runId), moduleId:String(run.moduleId), type:run.type,
    name:String(run.name).trim(), durationMin:run.durationMs / 60_000,
    durationMs:Math.round(run.durationMs), blackout:run.blackout === true,
    workspaceCommandId:String(run.workspaceCommandId || ""),
    projectPath:normalizedProjectPath || null, startedAtMs:Number(run.startedAtMs) || 0,
    ...(run.recoveryOnly === true ? { recoveryOnly:true } : {}),
    ...(Object.prototype.hasOwnProperty.call(run, "lighting") ? { lighting:normalizeLightingSnapshot(run.lighting) } : {})
  };
}

/** @param {unknown} value @returns {import("../../types/contracts").Attention | null} */
function normalizeAttention(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attention = /** @type {AnyRecord} */ (value);
  if (![TIMER_STAGE.FOCUS, TIMER_STAGE.BREAK].includes(attention.type)) return null;
  const moduleRun = normalizeModuleRun(attention.moduleRun);
  if (!moduleRun || !Number.isFinite(attention.durationMs) || attention.durationMs <= 0) return null;
  return {
    type:attention.type, nextStarted:attention.nextStarted === true,
    durationMs:Math.round(attention.durationMs),
    ...(Number.isInteger(attention.moduleIndex) && attention.moduleIndex >= 0 ? { moduleIndex:attention.moduleIndex } : {}),
    moduleRun
  };
}

/** @param {unknown} value @returns {import("../../types/contracts").BreakTransition | null} */
function normalizeBreakTransition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = /** @type {AnyRecord} */ (value);
  if (item.schemaVersion !== 1 || item.status !== "break-completing" || item.mode !== "modules"
    || typeof item.autoNext !== "boolean" || !Number.isFinite(item.durationMs) || item.durationMs <= 0
    || !Number.isFinite(item.createdAtMs) || item.createdAtMs <= 0) return null;
  if (item.moduleIndex != null && (!Number.isInteger(item.moduleIndex) || item.moduleIndex < 0)) return null;
  if (item.moduleRun && !normalizeModuleRun(item.moduleRun)) return null;
  if (item.completionType === "work"
    && (!Number.isInteger(item.completedWorkCountAfter) || !Number.isInteger(item.sessionCountAfter))) return null;
  return /** @type {import("../../types/contracts").BreakTransition} */ (cloneValue(item));
}

/** @param {unknown} value @param {"sessionId"|"key"} key @returns {AnyRecord[]} */
function normalizeQueue(value, key) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const path = markdownPath(item?.path);
    return item && typeof item === "object" && String(item[key] || "") && path
      ? [{ ...cloneValue(item), path }] : [];
  });
}

/** @param {unknown} raw @param {Settings} settings @param {number} [now] @returns {Runtime} */
function normalizeCurrentRuntime(raw, settings, now=Date.now()) {
  const defaults = createRuntimeDefaults(settings);
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {AnyRecord} */ (raw) : {};
  const settlementError = source.pendingSettlement ? validateSettlementJournal(source.pendingSettlement) : null;
  let settlement = settlementError ? null : source.pendingSettlement ? cloneValue(source.pendingSettlement) : null;
  try {
    if (settlement) {
      settlement.daily.path = normalizeMarkdownPath(settlement.daily.path, normalizePath);
      if (settlement.project.path) settlement.project.path = normalizeMarkdownPath(settlement.project.path, normalizePath);
    }
  } catch (error) {
    // An invalid saved path is quarantined just like an invalid journal.
    return quarantineRuntime(defaults, source, now, `journal 路径非法：${error instanceof Error ? error.message : String(error)}`);
  }
  if (settlementError) return quarantineRuntime(defaults, source, now, settlementError);
  const status = Object.values(TIMER_STATUS).includes(source.status) ? source.status : TIMER_STATUS.IDLE;
  const stage = [TIMER_STAGE.FOCUS, TIMER_STAGE.BREAK].includes(source.stage) ? source.stage : null;
  const durationMs = Math.max(0, Number(source.durationMs) || 0);
  const result = /** @type {Runtime} */ ({
    ...defaults, status, stage, moduleRun:normalizeModuleRun(source.moduleRun),
    currentModuleIndex:Math.max(0, Math.floor(Number(source.currentModuleIndex) || 0)),
    selectedModuleId:String(source.selectedModuleId || "") || null,
    completedWorkCount:Math.max(0, Math.floor(Number(source.completedWorkCount) || 0)),
    completedRestCount:Math.max(0, Math.floor(Number(source.completedRestCount) || 0)),
    completedLoopCount:Math.max(0, Math.floor(Number(source.completedLoopCount) || 0)),
    durationMs, startedAtMs:Number(source.startedAtMs) || 0,
    elapsedMs:Math.max(0, Number(source.elapsedMs) || 0),
    remainingMs:Math.max(0, Number(source.remainingMs) || 0), pausedAtMs:Number(source.pausedAtMs) || 0,
    sessionId:source.sessionId || source.moduleRun?.runId || null,
    plannedTomatoCredit:stage === TIMER_STAGE.FOCUS ? plannedTomatoAmount(durationMs) : 0,
    attention:normalizeAttention(source.attention), pendingSettlement:settlement,
    pendingBreakTransition:normalizeBreakTransition(source.pendingBreakTransition),
    quarantinedSettlement:source.quarantinedSettlement && typeof source.quarantinedSettlement === "object" ? cloneValue(source.quarantinedSettlement) : null,
    projectQueue:normalizeQueue(source.projectQueue, "sessionId"),
    frontmatterQueue:normalizeQueue(source.frontmatterQueue, "key"),
    sessionCount:Math.max(0, Math.floor(Number(source.sessionCount) || 0)),
    dayKey:String(source.dayKey || ""), viewWasOpen:!!source.viewWasOpen,
    failure:source.failure && typeof source.failure === "object" ? cloneValue(source.failure) : null
  });
  const definitions = Array.isArray(settings.modules) ? settings.modules : [];
  const selectedId = result.attention?.moduleRun?.moduleId || result.moduleRun?.moduleId || result.selectedModuleId;
  const selectedIndex = definitions.findIndex(item => item.id === selectedId);
  const fallbackIndex = Math.min(result.currentModuleIndex || 0, Math.max(0, definitions.length - 1));
  result.selectedModuleId = definitions[selectedIndex >= 0 ? selectedIndex : fallbackIndex]?.id || null;
  if (result.status === TIMER_STATUS.IDLE) result.currentModuleIndex = selectedIndex >= 0 ? selectedIndex : fallbackIndex;
  if (result.attention && !result.attention.nextStarted) result.status = TIMER_STATUS.AWAITING;
  if (result.status === TIMER_STATUS.AWAITING && !result.attention) result.status = TIMER_STATUS.IDLE;
  if (result.status === TIMER_STATUS.AWAITING && result.attention?.nextStarted) result.attention.nextStarted = false;
  if (/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED, TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED]).includes(result.status)
    && result.attention?.nextStarted && result.stage !== result.attention.type) result.attention = null;
  if (result.status === TIMER_STATUS.IDLE) {
    Object.assign(result, { stage:null, durationMs:0, startedAtMs:0, elapsedMs:0, remainingMs:0,
      pausedAtMs:0, sessionId:null, plannedTomatoCredit:0, attention:null, moduleRun:null, failure:null });
  } else if (result.status === TIMER_STATUS.AWAITING) {
    Object.assign(result, { stage:null, durationMs:0, startedAtMs:0, elapsedMs:0,
      remainingMs:result.attention?.durationMs || result.remainingMs, pausedAtMs:0,
      sessionId:null, plannedTomatoCredit:0, moduleRun:null, failure:null });
  } else if (!result.stage && result.status === TIMER_STATUS.FAILED && result.quarantinedSettlement) {
    result.attention = null;
  } else if (!result.stage) {
    Object.assign(result, { status:TIMER_STATUS.IDLE, durationMs:0, startedAtMs:0,
      elapsedMs:0, remainingMs:0, pausedAtMs:0, sessionId:null, plannedTomatoCredit:0,
      moduleRun:null, attention:null, failure:null });
  } else if (result.status === TIMER_STATUS.PAUSED) {
    result.remainingMs = Math.min(result.durationMs, Math.max(0, result.remainingMs));
    if (!result.durationMs || result.remainingMs <= 0) {
      result.status = TIMER_STATUS.FAILED;
      result.failure = { stage:result.stage, sessionId:result.sessionId, atMs:now, message:"暂停状态缺少有效剩余时间" };
    } else {
      result.startedAtMs = 0;
      result.elapsedMs = result.durationMs - result.remainingMs;
      result.pausedAtMs = result.pausedAtMs || now;
    }
  } else if (result.status === TIMER_STATUS.RUNNING && (!result.durationMs || !result.startedAtMs)) {
    result.status = TIMER_STATUS.FAILED;
    result.failure = { stage:result.stage, sessionId:result.sessionId, atMs:now, message:"运行状态缺少有效开始时间" };
  }
  if (/** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(result.status) && !result.moduleRun) {
    result.status = TIMER_STATUS.FAILED;
    result.failure = { stage:result.stage, sessionId:result.sessionId, atMs:now, message:"模块执行快照缺失" };
  }
  if (result.status === TIMER_STATUS.SETTLING && !result.pendingSettlement && !result.pendingBreakTransition) {
    result.status = TIMER_STATUS.FAILED;
    result.failure = { stage:result.stage, sessionId:result.sessionId, atMs:now, message:"转换状态缺少 journal" };
  }
  if (/** @type {string[]} */ ([TIMER_STATUS.SETTLING, TIMER_STATUS.FAILED]).includes(result.status)) result.attention = null;
  return result;
}

/** @param {Runtime} defaults @param {AnyRecord} source @param {number} now @param {string} error @returns {Runtime} */
function quarantineRuntime(defaults, source, now, error) {
  return {
    ...defaults, status:TIMER_STATUS.FAILED,
    projectQueue:normalizeQueue(source.projectQueue, "sessionId"),
    frontmatterQueue:normalizeQueue(source.frontmatterQueue, "key"),
    sessionCount:Math.max(0, Math.floor(Number(source.sessionCount) || 0)),
    completedWorkCount:Math.max(0, Math.floor(Number(source.completedWorkCount) || 0)),
    completedRestCount:Math.max(0, Math.floor(Number(source.completedRestCount) || 0)),
    completedLoopCount:Math.max(0, Math.floor(Number(source.completedLoopCount) || 0)),
    dayKey:String(source.dayKey || ""), viewWasOpen:!!source.viewWasOpen,
    quarantinedSettlement:{ sessionId:String(source.pendingSettlement?.sessionId || "") || null,
      schemaVersion:Number.isFinite(source.pendingSettlement?.schemaVersion) ? source.pendingSettlement.schemaVersion : null,
      atMs:now, error },
    failure:{ operation:"quarantineSettlement", sessionId:String(source.pendingSettlement?.sessionId || "") || null,
      stage:TIMER_STAGE.FOCUS, target:null, step:"validate", atMs:now, message:`无效结算 journal 已隔离：${error}` }
  };
}

module.exports = { createRuntimeDefaults, normalizeModuleRun, normalizeCurrentRuntime };
