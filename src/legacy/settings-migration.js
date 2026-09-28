const { normalizeModuleDefinition, normalizeOrchestration, makeUniqueId } = require("../core/modules");
const MODULE_TYPES = { WORK:"work", REST:"rest" };
/** @typedef {Record<string, any>} AnyRecord */
/** @typedef {import("../../types/contracts").ModuleDefinition} ModuleDefinition */
/** @typedef {{loopMode:"infinite"|"once"|"count",loopCount:number,autoAdvance:boolean,enableProjects:boolean}} Orchestration */
/** @param {unknown} value @param {string} [fallback] */
const cleanText = (value, fallback = "") => String(value ?? "").trim() || fallback;

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


const LEGACY_SETTING_KEYS = [
  "workMode", "cycleTaskA", "cycleTaskB", "cycleMinA", "cycleMinB",
  "cycleWorkspaceCommandA", "cycleWorkspaceCommandB", "cycleTaskBlackoutA",
  "cycleTaskBlackoutB", "cycleBreakEvery", "cycleBreakEnabled",
  "longFocusDefaultMin", "focusMin", "breakMin", "longBreakMin", "longEvery",
  "autoNext", "projectEnable", "currentProjectPath", "showProjectSelector",
  "taskBlackoutEnabled", "breakBlackoutEnabled", "focusStartCommandId",
  "breakStartCommandId"
];
/** @template T @param {T} settings @returns {T} */
function stripLegacySettings(settings) {
  for (const key of LEGACY_SETTING_KEYS) delete /** @type {Record<string, any>} */ (settings)[key];
  return settings;
}
module.exports = { migrateLegacySettings, stripLegacySettings };
