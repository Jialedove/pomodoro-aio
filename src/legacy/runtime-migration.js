const { createSessionId } = require("../core/timer");

/**
 * Convert a pre-V5 live segment into one isolated module run. The upgrade
 * preserves the current timer and journal, then ends that legacy segment.
 * The saved module sequence remains the user's migrated Work/Rest sequence.
 * @param {Record<string, any>} runtime
 * @param {Record<string, any>} source
 * @param {Record<string, any>} settings
 * @param {number} now
 */
function migrateLegacyRuntime(runtime, source, settings, now) {
  const stripLegacyFields = () => {
    runtime.mode = "modules";
    for (const key of ["cycleSlot", "cycleRoundCount", "currentTaskName", "longFocusMinutes", "breakContinuation"]) delete runtime[key];
    if (runtime.attention) {
      for (const key of ["isLong", "cycleSlot", "taskName"]) delete runtime.attention[key];
    }
    if (runtime.pendingBreakTransition) {
      for (const key of ["cycleSlot", "taskName", "isLong", "cycleRoundCountAfter", "breakContinuation"]) {
        delete runtime.pendingBreakTransition[key];
      }
    }
    return runtime;
  };
  if (Number(source.schemaVersion) >= 5) {
    return stripLegacyFields();
  }
  const active = ["running", "paused", "settling", "settlement-failed"].includes(runtime.status);
  /** @param {"work"|"rest"} type @param {number} durationMs @param {string} name @param {string} runId */
  const moduleRun = (type, durationMs, name, runId) => ({
    runId:runId || createSessionId(),
    moduleId:`legacy-recovery-${type}`,
    type,
    name:name || (type === "work" ? "工作" : "休息"),
    durationMin:durationMs / 60_000,
    durationMs,
    blackout:false,
    workspaceCommandId:null,
    projectPath:null,
    startedAtMs:Number(source.startedAtMs) || now,
    recoveryOnly:true
  });
  if (active && !runtime.moduleRun && runtime.stage && runtime.durationMs > 0) {
    runtime.moduleRun = moduleRun(runtime.stage === "focus" ? "work" : "rest", runtime.durationMs,
      String(source.currentTaskName || source.taskName || "").trim(), String(runtime.sessionId || ""));
    runtime.currentModuleIndex = 0;
  }
  if (runtime.attention && !runtime.attention.moduleRun) {
    runtime.attention.moduleRun = moduleRun(runtime.attention.type === "focus" ? "work" : "rest",
      runtime.attention.durationMs, String(runtime.attention.taskName || source.currentTaskName || "").trim(), "");
    runtime.attention.moduleIndex = 0;
  }
  if (runtime.pendingSettlement?.transition?.mode !== "modules" && runtime.pendingSettlement) {
    const journal = runtime.pendingSettlement;
    journal.transition = {
      mode:"modules", durationMs:1, autoNext:false, moduleIndex:null, moduleRun:null,
      completedWorkCountAfter:(runtime.completedWorkCount || 0) + 1,
      completedRestCountAfter:runtime.completedRestCount || 0,
      completedLoopCountAfter:runtime.completedLoopCount || 0
    };
  }
  if (runtime.pendingBreakTransition?.mode !== "modules" && runtime.pendingBreakTransition) {
    const transition = runtime.pendingBreakTransition;
    Object.assign(transition, {
      mode:"modules", completionType:"rest", autoNext:false, durationMs:1,
      moduleIndex:null, moduleRun:null,
      completedRestCountAfter:(runtime.completedRestCount || 0) + 1,
      completedWorkCountAfter:runtime.completedWorkCount || 0,
      completedLoopCountAfter:runtime.completedLoopCount || 0
    });
  }
  return stripLegacyFields();
}

module.exports = { migrateLegacyRuntime };
