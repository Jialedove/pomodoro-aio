const MODULE_TYPES = Object.freeze({ WORK: "work", REST: "rest" });
const { createLightingSnapshot } = require("./lighting");
const LOOP_MODES = Object.freeze({ INFINITE: "infinite", ONCE: "once", COUNT: "count" });
const DEFAULT_REST_PRESETS = Object.freeze(["NSDR 非睡眠深度休息", "在窗边看远方", "散步", "闭眼休息", "喝水", "拉伸"]);
/** @typedef {Record<string, any>} AnyRecord */
/** @typedef {import("../../types/contracts").ModuleDefinition} ModuleDefinition */
/** @typedef {{loopMode:"infinite"|"once"|"count",loopCount:number,autoAdvance:boolean,enableProjects:boolean}} Orchestration */

/** @param {unknown} value @param {string} fallback */
function cleanText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/** @param {unknown} value @param {number} fallback */
function positiveMinutes(value, fallback = 25) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? Math.max(1, Math.round(minutes * 10) / 10) : fallback;
}

/** @param {unknown} [value] @returns {string[]} */
function normalizeRestPresets(value) {
  if (!Array.isArray(value)) return [...DEFAULT_REST_PRESETS];
  const seen = new Set();
  return value.map(item => String(item ?? "").trim().slice(0, 80)).filter(item => {
    if (!item || seen.has(item) || seen.size >= 40) return false;
    seen.add(item);
    return true;
  });
}

/** @param {string} prefix */
function makeUniqueId(prefix = "module") {
  try {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  } catch (_) { /* use the local fallback below */ }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** @param {unknown} input @param {{id?:string, idFactory?:(type:string)=>string, fallbackName?:string, fallbackType?:"work"|"rest"}} [options] @returns {ModuleDefinition} */
function normalizeModuleDefinition(input, options = {}) {
  /** @type {AnyRecord} */
  const source = input && typeof input === "object" && !Array.isArray(input) ? /** @type {AnyRecord} */ (input) : {};
  const type = source.type === MODULE_TYPES.REST || source.type === MODULE_TYPES.WORK
    ? source.type : (options.fallbackType || MODULE_TYPES.WORK);
  const id = cleanText(options.id || source.id, "") || (options.idFactory || makeUniqueId)(type);
  /** @type {ModuleDefinition} */
  const normalized = {
    id,
    type,
    name: cleanText(source.name, options.fallbackName || (type === MODULE_TYPES.WORK ? "工作" : "休息")),
    durationMin: positiveMinutes(source.durationMin, type === MODULE_TYPES.WORK ? 25 : 5),
    blackout: source.blackout === true
  };
  const workspaceCommandId = cleanText(source.workspaceCommandId);
  if (workspaceCommandId) normalized.workspaceCommandId = workspaceCommandId;
  const lightProgramId = cleanText(source.lightProgramId);
  if (lightProgramId && lightProgramId !== "inherit") normalized.lightProgramId = lightProgramId;
  return normalized;
}

/** @param {unknown} value @returns {Orchestration} */
function normalizeOrchestration(value = {}) {
  /** @type {AnyRecord} */
  const source = value && typeof value === "object" && !Array.isArray(value) ? /** @type {AnyRecord} */ (value) : {};
  const loopMode = Object.values(LOOP_MODES).includes(source.loopMode) ? source.loopMode : LOOP_MODES.INFINITE;
  const count = Number(source.loopCount);
  return {
    loopMode,
    loopCount: Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1,
    autoAdvance: source.autoAdvance === true,
    enableProjects: source.enableProjects === true
  };
}

/**
 * Advance after the module at currentIndex has completed. completedLoopCount is
 * the number of complete sequences before this completion.
 * @param {Array<{id:string}>} modules @param {number} currentIndex @param {number} completedLoopCount
 * @param {{loopMode?:string,loopCount?:number}} orchestration
 */
function getNextModule(modules, currentIndex, completedLoopCount = 0, orchestration = {}) {
  const loops = Math.max(0, Math.floor(Number(completedLoopCount) || 0));
  if (!Array.isArray(modules) || modules.length === 0 || !Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= modules.length) {
    return { nextIndex: null, completedLoopCount: loops, shouldStop: true };
  }
  const endOfSequence = currentIndex === modules.length - 1;
  const nextLoops = loops + (endOfSequence ? 1 : 0);
  const config = normalizeOrchestration(orchestration);
  const limit = config.loopMode === LOOP_MODES.ONCE ? 1 : config.loopMode === LOOP_MODES.COUNT ? config.loopCount : Infinity;
  const shouldStop = endOfSequence && nextLoops >= limit;
  return {
    nextIndex: shouldStop ? null : (endOfSequence ? 0 : currentIndex + 1),
    completedLoopCount: nextLoops,
    shouldStop
  };
}

/** @param {Record<string, any>} module @param {Record<string,string>} [projectAssignments] @param {{enableProjects?:boolean,runId?:string,startedAtMs?:number,idFactory?:(type:string)=>string,settings?:Record<string, any>}} [options] */
function createModuleRunSnapshot(module, projectAssignments = {}, options = {}) {
  const definition = normalizeModuleDefinition(module);
  const enableProjects = options.enableProjects === true;
  const projectPath = enableProjects && definition.type === MODULE_TYPES.WORK
    ? cleanText(projectAssignments?.[definition.id]) || null
    : null;
  /** @type {import("../../types/contracts").ModuleRun} */
  const snapshot = {
    runId: cleanText(options.runId) || (options.idFactory || makeUniqueId)("run"),
    moduleId: definition.id,
    type: definition.type,
    name: definition.name,
    durationMin: definition.durationMin,
    durationMs: Math.round(definition.durationMin * 60 * 1000),
    blackout: definition.blackout,
    workspaceCommandId: definition.workspaceCommandId || null,
    projectPath,
    startedAtMs: Number.isFinite(Number(options.startedAtMs)) ? Number(options.startedAtMs) : Date.now()
  };
  if (options.settings) snapshot.lighting = createLightingSnapshot(definition, options.settings);
  return Object.freeze(snapshot);
}

module.exports = {
  MODULE_TYPES,
  LOOP_MODES,
  DEFAULT_REST_PRESETS,
  normalizeRestPresets,
  normalizeModuleDefinition,
  makeUniqueId,
  normalizeOrchestration,
  getNextModule,
  createModuleRunSnapshot
};
