const { TIMER_STATUS, TIMER_STAGE, plannedTomatoAmount } = require("./timer");
/** @typedef {import("../../types/contracts").Runtime} Runtime */
/** @typedef {import("../../types/contracts").RuntimeEvent} RuntimeEvent */
/** @typedef {import("../../types/contracts").RuntimeTransition} RuntimeTransition */

const RUNTIME_EVENT = Object.freeze({
  DAY_ROLLOVER: "day-rollover",
  START_STAGE: "start-stage",
  AWAIT_STAGE: "await-stage",
  PAUSE: "pause",
  RESUME: "resume",
  RESET: "reset",
  SET_ATTENTION: "set-attention",
  CLEAR_ATTENTION: "clear-attention",
  BEGIN_FOCUS_SETTLEMENT: "begin-focus-settlement",
  SET_PENDING_SETTLEMENT: "set-pending-settlement",
  RESUME_SETTLEMENT: "resume-settlement",
  FINALIZE_SETTLEMENT: "finalize-settlement",
  RESTORE_ACTIVE_STAGE: "restore-active-stage",
  CLEAR_PENDING_SETTLEMENT: "clear-pending-settlement",
  BEGIN_BREAK_TRANSITION: "begin-break-transition",
  RESTORE_FOCUS: "restore-focus",
  CLEAR_BREAK_TRANSITION: "clear-break-transition",
  FAIL: "fail",
  SET_TASK: "set-task",
  SET_VIEW_OPEN: "set-view-open",
  SELECT_MODULE: "select-module",
  SELECT_CYCLE_SLOT: "select-cycle-slot",
  SET_LONG_FOCUS: "set-long-focus"
  , FINISH_SEQUENCE: "finish-sequence"
  , COMPLETE_REST: "complete-rest"
  , COMPLETE_EMPTY_WORK: "complete-empty-work"
});

const RUNTIME_EFFECT = Object.freeze({
  ALERT_START: "alert-start",
  ALERT_STOP: "alert-stop",
  BROADCAST: "broadcast",
  RESYNC: "resync"
});

/** @param {Runtime} runtime @param {string[]} [effects] @returns {RuntimeTransition} */
function result(runtime, effects = []) {
  return { runtime, effects };
}

/** @param {Runtime} runtime @param {import("../../types/contracts").TimerStatus} status @param {number} [remainingMs] @returns {Runtime} */
function clearedStage(runtime, status, remainingMs = 0) {
  return {
    ...runtime,
    status,
    stage: null,
    durationMs: 0,
    startedAtMs: 0,
    elapsedMs: 0,
    remainingMs: Math.max(0, Number(remainingMs) || 0),
    pausedAtMs: 0,
    sessionId: null,
    plannedTomatoCredit: 0,
    breakContinuation: null,
    moduleRun: null
  };
}

/** @param {Runtime} runtime @param {RuntimeEvent} event @returns {RuntimeTransition} */
function reduceRuntime(runtime, event) {
  switch (event?.type) {
    case RUNTIME_EVENT.DAY_ROLLOVER:
      return result({ ...runtime, dayKey:event.dayKey, sessionCount:0 }, [RUNTIME_EFFECT.BROADCAST]);

    case RUNTIME_EVENT.START_STAGE: {
      const durationMs = Math.max(1, Math.round(Number(event.durationMs) || 1));
      const next = {
        ...runtime,
        status: TIMER_STATUS.RUNNING,
        stage: event.stage,
        mode: event.mode ?? runtime.mode,
        cycleSlot: event.cycleSlot ?? runtime.cycleSlot,
        durationMs,
        startedAtMs: event.now,
        elapsedMs: 0,
        remainingMs: durationMs,
        pausedAtMs: 0,
        sessionId: event.sessionId ?? null,
        plannedTomatoCredit: event.stage === TIMER_STAGE.FOCUS ? plannedTomatoAmount(durationMs) : 0,
        moduleRun: event.moduleRun ?? null,
        currentModuleIndex: Number.isInteger(event.moduleIndex) ? event.moduleIndex : runtime.currentModuleIndex,
        selectedModuleId: event.moduleRun?.moduleId ?? runtime.selectedModuleId,
        completedWorkCount:event.newSequence ? 0 : runtime.completedWorkCount,
        completedRestCount:event.newSequence ? 0 : runtime.completedRestCount,
        completedLoopCount:event.newSequence ? 0 : runtime.completedLoopCount,
        cycleRoundCount: event.mode === "cycle" && Number.isInteger(event.cycleRoundCount)
          ? Math.max(0, event.cycleRoundCount)
          : runtime.cycleRoundCount,
        breakContinuation: event.stage === TIMER_STAGE.BREAK ? (event.breakContinuation ?? null) : null,
        attention: null,
        failure: null
      };
      if (event.currentTaskName !== undefined) next.currentTaskName = String(event.currentTaskName || "").trim();
      if (event.longFocusMinutes !== undefined) next.longFocusMinutes = event.longFocusMinutes;
      return result(next, [RUNTIME_EFFECT.ALERT_STOP, RUNTIME_EFFECT.BROADCAST, RUNTIME_EFFECT.RESYNC]);
    }

    case RUNTIME_EVENT.AWAIT_STAGE: {
      const next = clearedStage({
        ...runtime,
        mode: event.mode ?? runtime.mode,
        cycleSlot: event.cycleSlot ?? runtime.cycleSlot,
        attention: null,
        failure: null
      }, TIMER_STATUS.AWAITING, event.durationMs);
      next.breakContinuation = event.breakContinuation ?? null;
      next.currentModuleIndex = Number.isInteger(event.moduleIndex) ? event.moduleIndex : runtime.currentModuleIndex;
      if (event.currentTaskName !== undefined) next.currentTaskName = String(event.currentTaskName || "").trim();
      return result(next, [RUNTIME_EFFECT.ALERT_STOP, RUNTIME_EFFECT.BROADCAST, RUNTIME_EFFECT.RESYNC]);
    }

    case RUNTIME_EVENT.PAUSE:
      if (runtime.status !== TIMER_STATUS.RUNNING) return result(runtime);
      return result({
        ...runtime,
        status:TIMER_STATUS.PAUSED,
        elapsedMs:event.elapsedMs,
        remainingMs:Math.max(0, runtime.durationMs - event.elapsedMs),
        startedAtMs:0,
        pausedAtMs:event.now,
        attention:null
      }, [RUNTIME_EFFECT.ALERT_STOP, RUNTIME_EFFECT.BROADCAST, RUNTIME_EFFECT.RESYNC]);

    case RUNTIME_EVENT.RESUME:
      if (runtime.status !== TIMER_STATUS.PAUSED) return result(runtime);
      return result({
        ...runtime,
        status:TIMER_STATUS.RUNNING,
        startedAtMs:event.now,
        pausedAtMs:0,
        remainingMs:Math.max(0, runtime.durationMs - runtime.elapsedMs),
        attention:null
      }, [RUNTIME_EFFECT.ALERT_STOP, RUNTIME_EFFECT.BROADCAST, RUNTIME_EFFECT.RESYNC]);

    case RUNTIME_EVENT.RESET:
      return result({
        ...clearedStage(runtime, TIMER_STATUS.IDLE),
        mode:event.mode,
        cycleSlot:0,
        cycleRoundCount:0,
        currentModuleIndex:0,
        selectedModuleId:event.selectedModuleId ?? null,
        completedWorkCount:0,
        completedRestCount:0,
        completedLoopCount:0,
        attention:null,
        pendingBreakTransition:null,
        breakContinuation:null,
        failure:null
      }, [RUNTIME_EFFECT.ALERT_STOP, RUNTIME_EFFECT.BROADCAST, RUNTIME_EFFECT.RESYNC]);

    case RUNTIME_EVENT.SET_ATTENTION: {
      const continuation = event.breakContinuation !== undefined
        ? event.breakContinuation
        : event.attention?.type === TIMER_STAGE.BREAK ? (runtime.breakContinuation ?? null) : null;
      const next = { ...runtime, attention:event.attention, breakContinuation:continuation,
        selectedModuleId:event.attention?.moduleRun?.moduleId ?? runtime.selectedModuleId };
      if (event.attention.nextStarted) return result(next, [RUNTIME_EFFECT.ALERT_START, RUNTIME_EFFECT.BROADCAST]);
      const awaiting = clearedStage(next, TIMER_STATUS.AWAITING, event.attention.durationMs);
      awaiting.breakContinuation = continuation;
      return result(awaiting, [RUNTIME_EFFECT.ALERT_START, RUNTIME_EFFECT.BROADCAST]);
    }

    case RUNTIME_EVENT.CLEAR_ATTENTION:
      return result({ ...runtime, attention:null }, [RUNTIME_EFFECT.ALERT_STOP, RUNTIME_EFFECT.BROADCAST]);

    case RUNTIME_EVENT.SELECT_MODULE:
      if (runtime.pendingSettlement || runtime.pendingBreakTransition) return result(runtime);
      if (runtime.status === TIMER_STATUS.IDLE && !runtime.attention) {
        return result({ ...runtime, mode:"modules", currentModuleIndex:event.moduleIndex,
          selectedModuleId:event.moduleId }, [RUNTIME_EFFECT.BROADCAST]);
      }
      if (runtime.status === TIMER_STATUS.AWAITING && runtime.attention?.moduleRun && event.attention) {
        return result({ ...runtime, currentModuleIndex:event.moduleIndex,
          selectedModuleId:event.moduleId, attention:event.attention,
          remainingMs:event.attention.durationMs }, [RUNTIME_EFFECT.BROADCAST]);
      }
      return result(runtime);

    case RUNTIME_EVENT.BEGIN_FOCUS_SETTLEMENT:
      return result({
        ...runtime,
        status:TIMER_STATUS.SETTLING,
        sessionId:event.sessionId,
        attention:null
      }, [RUNTIME_EFFECT.ALERT_STOP]);

    case RUNTIME_EVENT.SET_PENDING_SETTLEMENT:
      return result({ ...runtime, pendingSettlement:event.journal });

    case RUNTIME_EVENT.RESUME_SETTLEMENT: {
      const early = ["prepared", "dailyApplied", "projectApplied"].includes(event.journal.status);
      return result({
        ...runtime,
        status:TIMER_STATUS.SETTLING,
        sessionId:event.journal.sessionId,
        stage:early ? TIMER_STAGE.FOCUS : runtime.stage,
        durationMs:early ? event.journal.durationMs : runtime.durationMs,
        attention:null,
        failure:null
      }, [RUNTIME_EFFECT.ALERT_STOP]);
    }

    case RUNTIME_EVENT.FINALIZE_SETTLEMENT:
      return result({
        ...runtime,
        sessionCount:Math.max(runtime.sessionCount || 0, Number(event.journal.sessionCountAfter) || 0),
        completedWorkCount:event.journal.transition?.mode === "modules"
          ? Math.max(runtime.completedWorkCount || 0, Number(event.journal.transition.completedWorkCountAfter) || 0)
          : runtime.completedWorkCount,
        completedLoopCount:event.journal.transition?.mode === "modules"
          ? Math.max(runtime.completedLoopCount || 0, Number(event.journal.transition.completedLoopCountAfter) || 0)
          : runtime.completedLoopCount,
        cycleRoundCount:event.journal.transition?.mode === "cycle" && Number.isInteger(event.journal.transition.cycleRoundCountAfter)
          ? Math.max(runtime.cycleRoundCount || 0, event.journal.transition.cycleRoundCountAfter)
          : runtime.cycleRoundCount,
        sessionId:event.journal.sessionId
      });

    case RUNTIME_EVENT.RESTORE_ACTIVE_STAGE:
      return result({
        ...runtime,
        status:runtime.startedAtMs ? TIMER_STATUS.RUNNING : TIMER_STATUS.PAUSED,
        sessionId:runtime.moduleRun?.runId || null,
        plannedTomatoCredit:runtime.stage === TIMER_STAGE.FOCUS ? plannedTomatoAmount(runtime.durationMs) : 0,
        failure:null
      });

    case RUNTIME_EVENT.CLEAR_PENDING_SETTLEMENT:
      return result({ ...runtime, pendingSettlement:null }, [RUNTIME_EFFECT.BROADCAST, RUNTIME_EFFECT.RESYNC]);

    case RUNTIME_EVENT.BEGIN_BREAK_TRANSITION:
      return result({
        ...runtime,
        pendingBreakTransition:event.transition,
        status:TIMER_STATUS.SETTLING,
        attention:null
      }, [RUNTIME_EFFECT.ALERT_STOP, RUNTIME_EFFECT.BROADCAST]);

    case RUNTIME_EVENT.RESTORE_FOCUS:
      return result({
        ...runtime,
        status:runtime.startedAtMs ? TIMER_STATUS.RUNNING : TIMER_STATUS.PAUSED,
        failure:null
      });

    case RUNTIME_EVENT.CLEAR_BREAK_TRANSITION:
      return result({ ...runtime, pendingBreakTransition:null, breakContinuation:null }, [RUNTIME_EFFECT.BROADCAST, RUNTIME_EFFECT.RESYNC]);

    case RUNTIME_EVENT.FAIL:
      return result({
        ...runtime,
        status:TIMER_STATUS.FAILED,
        attention:null,
        failure:event.failure
      }, [RUNTIME_EFFECT.ALERT_STOP, RUNTIME_EFFECT.BROADCAST]);

    case RUNTIME_EVENT.SET_TASK:
      return result({ ...runtime, currentTaskName:String(event.name || "").trim() }, [RUNTIME_EFFECT.BROADCAST]);

    case RUNTIME_EVENT.SET_VIEW_OPEN:
      return result({ ...runtime, viewWasOpen:!!event.open });

    case RUNTIME_EVENT.SELECT_CYCLE_SLOT:
      return result({ ...runtime, cycleSlot:event.slot === 1 ? 1 : 0 }, [RUNTIME_EFFECT.BROADCAST]);

    case RUNTIME_EVENT.SET_LONG_FOCUS:
      return result({ ...runtime, longFocusMinutes:event.minutes }, event.broadcast ? [RUNTIME_EFFECT.BROADCAST] : []);

    case RUNTIME_EVENT.COMPLETE_REST:
      return result({
        ...runtime,
        completedRestCount:Math.max(runtime.completedRestCount || 0, Number(event.completedRestCountAfter) || 0),
        completedLoopCount:Math.max(runtime.completedLoopCount || 0, Number(event.completedLoopCountAfter) || 0)
      }, [RUNTIME_EFFECT.BROADCAST]);

    case RUNTIME_EVENT.COMPLETE_EMPTY_WORK:
      return result({
        ...runtime,
        sessionCount:Math.max(runtime.sessionCount || 0, Number(event.sessionCountAfter) || 0),
        completedWorkCount:Math.max(runtime.completedWorkCount || 0, Number(event.completedWorkCountAfter) || 0),
        completedLoopCount:Math.max(runtime.completedLoopCount || 0, Number(event.completedLoopCountAfter) || 0)
      }, [RUNTIME_EFFECT.BROADCAST]);

    case RUNTIME_EVENT.FINISH_SEQUENCE:
      return result({ ...clearedStage(runtime, TIMER_STATUS.IDLE), currentModuleIndex:0,
        selectedModuleId:null, attention:null, failure:null },
        [RUNTIME_EFFECT.ALERT_STOP, RUNTIME_EFFECT.BROADCAST, RUNTIME_EFFECT.RESYNC]);

    default:
      throw new Error(`未知 runtime event：${event?.type || "empty"}`);
  }
}

module.exports = { RUNTIME_EVENT, RUNTIME_EFFECT, reduceRuntime };
