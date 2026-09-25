const MODULE_TYPES = Object.freeze({ WORK: "work", REST: "rest" });
const LOOP_MODES = Object.freeze({ INFINITE: "infinite", ONCE: "once", COUNT: "count" });
/** @typedef {Record<string, any>} AnyRecord */
/** @typedef {{id:string,type:"work"|"rest",name:string,durationMin:number,blackout:boolean,workspaceCommandId?:string}} ModuleDefinition */
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

/** @param {unknown} settings @param {{idFactory?:(type:string)=>string}} [options] @returns {AnyRecord & {modules:ModuleDefinition[],projectAssignments:Record<string,string>} & Orchestration} */
function migrateLegacySettings(settings = {}, options = {}) {
  /** @type {AnyRecord} */
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? /** @type {AnyRecord} */ (settings) : {};
  const orchestration = normalizeOrchestration({
    ...source,
    autoAdvance: source.autoAdvance ?? source.autoNext,
    enableProjects: source.enableProjects ?? source.projectEnable
  });
  /** @type {ModuleDefinition[]} */
  let modules;
  if (Array.isArray(source.modules)) {
    const usedIds = new Set();
    modules = source.modules.map((definition, index) => {
      const module = normalizeModuleDefinition(definition, {
        idFactory: options.idFactory,
        fallbackName: `模块 ${index + 1}`
      });
      if (usedIds.has(module.id)) {
        const baseId = (options.idFactory || makeUniqueId)(module.type);
        let uniqueId = baseId;
        let suffix = 2;
        while (usedIds.has(uniqueId)) uniqueId = `${baseId}-${suffix++}`;
        module.id = uniqueId;
      }
      usedIds.add(module.id);
      return module;
    });
  } else {
    modules = migrateLegacyModules(source, options);
  }
  const usedIds = new Set();
  for (const module of modules) {
    if (usedIds.has(module.id)) {
      const baseId = (options.idFactory || makeUniqueId)(module.type);
      let uniqueId = baseId;
      let suffix = 2;
      while (usedIds.has(uniqueId)) uniqueId = `${baseId}-${suffix++}`;
      module.id = uniqueId;
    }
    usedIds.add(module.id);
  }

  /** @type {Record<string, string>} */
  const projectAssignments = {};
  if (source.projectAssignments && typeof source.projectAssignments === "object" && !Array.isArray(source.projectAssignments)) {
    for (const module of modules) {
      const path = cleanText(source.projectAssignments[module.id]);
      if (module.type === MODULE_TYPES.WORK && path) projectAssignments[module.id] = path;
    }
  } else if (!Array.isArray(source.modules)) {
    const legacyProjectPath = cleanText(source.currentProjectPath);
    if (legacyProjectPath) {
      for (const module of modules) if (module.type === MODULE_TYPES.WORK) projectAssignments[module.id] = legacyProjectPath;
    }
  }

  return {
    ...source,
    modules,
    projectAssignments,
    ...orchestration
  };
}

/** @param {AnyRecord} source @param {{idFactory?:(type:string)=>string}} options @returns {ModuleDefinition[]} */
function migrateLegacyModules(source, options) {
  /** @param {string} id @param {"work"|"rest"} type */
  const idFor = (id, type) => id || (options.idFactory || makeUniqueId)(type);
  const standard = source.workMode !== "cycle";
  if (standard) {
    const work = normalizeModuleDefinition({
      type: "work",
      name: source.taskName || source.currentTaskName || source.defaultTaskName || "工作",
      durationMin: source.focusMin,
      blackout: source.taskBlackoutEnabled === true
    }, { id: idFor("legacy-standard-work", "work") });
    const rest = normalizeModuleDefinition({
      type: "rest",
      name: "休息",
      durationMin: source.breakMin,
      blackout: source.breakBlackoutEnabled === true
    }, { id: idFor("legacy-standard-rest", "rest") });
    const modules = [work, rest];
    const longMinutes = Number(source.longFocusDefaultMin);
    if (Number.isFinite(longMinutes) && longMinutes > 0 && Math.round(longMinutes * 10) / 10 !== work.durationMin) {
      modules.push(normalizeModuleDefinition({
        type: "work",
        name: "长专注",
        durationMin: longMinutes,
        blackout: source.taskBlackoutEnabled === true
      }, { id: idFor("legacy-long-focus", "work") }));
    }
    return modules;
  }

  const rounds = Math.max(1, Math.min(1000, Math.floor(Number(source.cycleBreakEvery) || 0) || 1));
  const taskA = cleanText(source.cycleTaskA, "工作 A");
  const taskB = cleanText(source.cycleTaskB, "工作 B");
  const modules = [];
  for (let round = 1; round <= rounds; round++) {
    modules.push(normalizeModuleDefinition({
      type: "work", name: taskA, durationMin: source.cycleMinA,
      blackout: source.cycleTaskBlackoutA === true,
      workspaceCommandId: source.cycleWorkspaceCommandA
    }, { id: idFor(`legacy-cycle-a-${round}`, "work") }));
    modules.push(normalizeModuleDefinition({
      type: "work", name: taskB, durationMin: source.cycleMinB,
      blackout: source.cycleTaskBlackoutB === true,
      workspaceCommandId: source.cycleWorkspaceCommandB
    }, { id: idFor(`legacy-cycle-b-${round}`, "work") }));
  }
  if (Number(source.cycleBreakEvery) > 0) {
    modules.push(normalizeModuleDefinition({
      type: "rest", name: "休息", durationMin: source.breakMin,
      blackout: source.breakBlackoutEnabled === true
    }, { id: idFor("legacy-cycle-rest", "rest") }));
  }
  return modules;
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

/** @param {Record<string, any>} module @param {Record<string,string>} [projectAssignments] @param {{enableProjects?:boolean,runId?:string,startedAtMs?:number,idFactory?:(type:string)=>string}} [options] */
function createModuleRunSnapshot(module, projectAssignments = {}, options = {}) {
  const definition = normalizeModuleDefinition(module);
  const enableProjects = options.enableProjects === true;
  const projectPath = enableProjects && definition.type === MODULE_TYPES.WORK
    ? cleanText(projectAssignments?.[definition.id]) || null
    : null;
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
  return Object.freeze(snapshot);
}

module.exports = {
  MODULE_TYPES,
  LOOP_MODES,
  normalizeModuleDefinition,
  normalizeOrchestration,
  migrateLegacySettings,
  getNextModule,
  createModuleRunSnapshot
};
