const { configuredStageDurationMs } = require("./timer");
const { TIMER_STAGE } = require("../core/timer");
const { planTaskLineMutation } = require("../core/task-lines");
/** @typedef {import("../../types/contracts").Settings} Settings */
/** @typedef {import("../../types/legacy-contracts").LegacyRuntime} Runtime */
/** @typedef {import("../../types/contracts").DailySettlementPlan} DailySettlementPlan */
/** @typedef {import("../../types/contracts").ProjectSettlementPlan} ProjectSettlementPlan */
/** @typedef {import("../../types/legacy-contracts").LegacySettlementJournal} SettlementJournal */
/** @typedef {import("../../types/legacy-contracts").LegacyStageTransition} StageTransition */

const JOURNAL_STATUSES = new Set(["prepared", "dailyApplied", "projectApplied", "runtimeFinalizing", "settled"]);
const PLAN_STATUSES = new Set(["pending", "applied"]);
const PROJECT_STATUSES = new Set(["skipped", "missing", "pending", "applied", "conflict"]);

/** @param {unknown} value @returns {string | null} */
function validateSettlementJournal(value) {
  /** @param {unknown} item @returns {item is Record<string, any>} */
  const record = item => !!item && typeof item === "object" && !Array.isArray(item);
  /** @param {unknown} item */
  const text = item => typeof item === "string" && !!item.trim();
  /** @param {unknown} item */
  const positive = item => typeof item === "number" && Number.isFinite(item) && item > 0;
  if (!record(value)) return "journal 不是对象";
  if (value.schemaVersion !== 1) return "journal schemaVersion 不受支持";
  if (!text(value.sessionId)) return "journal 缺少 sessionId";
  if (value.stage !== TIMER_STAGE.FOCUS) return "journal stage 非法";
  if (!positive(value.durationMs)) return "journal durationMs 非法";
  if (!text(value.taskName)) return "journal taskName 为空";
  if (!positive(value.amount)) return "journal amount 非法";
  if (typeof value.manual !== "boolean") return "journal manual 非法";
  if (!Number.isInteger(value.sessionCountAfter) || value.sessionCountAfter < 1) return "journal sessionCountAfter 非法";
  if (!positive(value.createdAtMs)) return "journal createdAtMs 非法";
  if (!JOURNAL_STATUSES.has(value.status)) return "journal status 非法";

  const daily = value.daily;
  if (!record(daily)) return "journal daily 非法";
  if (!text(daily.path)) return "journal daily.path 为空";
  if (!text(daily.taskName) || daily.taskName !== value.taskName) return "journal daily.taskName 非法";
  if (!text(daily.frontmatterKey)) return "journal daily.frontmatterKey 为空";
  if (!text(daily.lineAfter)) return "journal daily.lineAfter 为空";
  if (!text(daily.beforeHash)) return "journal daily.beforeHash 为空";
  if (!Number.isFinite(daily.expectedSum) || daily.expectedSum < 0) return "journal daily.expectedSum 非法";
  if (!["line", "insert"].includes(daily.kind)) return "journal daily.kind 非法";
  if (!PLAN_STATUSES.has(daily.rowStatus) || !PLAN_STATUSES.has(daily.frontmatterStatus)) return "journal daily status 非法";
  if (!["\n", "\r\n"].includes(daily.eol)) return "journal daily.eol 非法";
  if (daily.kind === "line" && (!Number.isInteger(daily.targetIndex) || daily.targetIndex < 0 || !text(daily.lineBefore))) return "journal daily line 计划非法";
  if (daily.kind === "insert" && (daily.targetIndex !== null || daily.lineBefore !== null)) return "journal daily insert 计划非法";

  const transition = value.transition;
  if (!record(transition) || !["standard", "cycle", "modules"].includes(transition.mode)) return "journal transition 非法";
  if (!positive(transition.durationMs) || typeof transition.autoNext !== "boolean") return "journal transition 字段非法";
  if (transition.mode === "modules") {
    if (transition.moduleIndex !== null && (!Number.isInteger(transition.moduleIndex) || transition.moduleIndex < 0)) return "journal moduleIndex 非法";
    if (transition.moduleIndex !== null && (!record(transition.moduleRun) || !text(transition.moduleRun.runId)
      || !text(transition.moduleRun.moduleId) || !["work", "rest"].includes(transition.moduleRun.type)
      || !positive(transition.moduleRun.durationMs))) return "journal moduleRun 非法";
    if (!Number.isInteger(transition.completedWorkCountAfter) || transition.completedWorkCountAfter < 1) return "journal work count 非法";
    if (!Number.isInteger(transition.completedLoopCountAfter) || transition.completedLoopCountAfter < 0) return "journal loop count 非法";
  }
  if (transition.mode === "standard" && typeof transition.isLong !== "boolean") return "journal standard transition 非法";
  if (transition.mode === "cycle" && (![0, 1].includes(transition.cycleSlot) || typeof transition.taskName !== "string")) return "journal cycle transition 非法";
  if (transition.cycleRoundCountAfter !== undefined
    && (!Number.isInteger(transition.cycleRoundCountAfter) || transition.cycleRoundCountAfter < 0)) return "journal cycle round count 非法";
  if (transition.cycleRestDurationMs !== undefined && !positive(transition.cycleRestDurationMs)) return "journal cycle rest 非法";

  const project = value.project;
  if (!record(project) || !PROJECT_STATUSES.has(project.status)) return "journal project 非法";
  if (typeof project.path !== "string" || !text(project.key) || !Number.isFinite(project.amount) || project.amount < 0) return "journal project 字段非法";
  if (project.status !== "skipped" && !text(project.path)) return "journal project.path 为空";
  if (project.deferred !== undefined && typeof project.deferred !== "boolean") return "journal project.deferred 非法";
  if (project.status !== "skipped" && project.deferred !== true
    && (!Number.isFinite(project.beforeValue) || !Number.isFinite(project.afterValue))) return "journal project 基线非法";
  return null;
}

/** @param {Settings} settings @param {Runtime} runtime @param {number} sessionCountAfter @returns {StageTransition} */
function buildNextStageTransition(settings, runtime, sessionCountAfter) {
  if (runtime?.mode === "cycle") {
    const cycleSlot = runtime.cycleSlot === 1 ? 0 : 1;
    const taskName = cycleSlot === 1 ? settings.cycleTaskB : settings.cycleTaskA;
    /** @type {StageTransition} */
    const transition = {
      mode: "cycle",
      cycleSlot,
      taskName: String(taskName || "").trim(),
      autoNext: false,
      durationMs: configuredStageDurationMs(settings, TIMER_STAGE.FOCUS, false, cycleSlot)
    };
    if (runtime.cycleSlot === 1) {
      transition.cycleRoundCountAfter = Math.max(0, Math.floor(Number(runtime.cycleRoundCount) || 0)) + 1;
      if (settings.cycleBreakEvery > 0 && transition.cycleRoundCountAfter % settings.cycleBreakEvery === 0) {
        transition.cycleRestDurationMs = configuredStageDurationMs(settings, TIMER_STAGE.BREAK, false);
      }
    }
    return transition;
  }
  const isLong = settings.longEvery > 0 && sessionCountAfter % settings.longEvery === 0;
  return {
    mode: "standard",
    isLong,
    autoNext: !!settings.autoNext,
    durationMs: configuredStageDurationMs(settings, TIMER_STAGE.BREAK, isLong)
  };
}

/** @param {unknown} sourceText @param {{path:string, taskName:string, amount:number, settings:Settings, frontmatterKey:string}} input @returns {DailySettlementPlan} */
function buildDailySettlementPlan(sourceText, { path, taskName, amount, settings, frontmatterKey }) {
  const daily = planTaskLineMutation(sourceText, taskName, amount, settings);
  /** @type {DailySettlementPlan} */
  const plan = Object.assign(daily, {
    path,
    taskName,
    frontmatterKey: frontmatterKey || "番茄数",
    rowStatus: /** @type {"pending"} */ ("pending"),
    frontmatterStatus: /** @type {"pending"} */ ("pending")
  });
  return plan;
}

/** @param {{sessionId:string, durationMs:number, taskName:string, amount:number, manual:boolean, sessionCountAfter:number, transition:StageTransition, createdAtMs:number, daily:DailySettlementPlan, project:ProjectSettlementPlan}} input @returns {SettlementJournal} */
function buildSettlementJournal({
  sessionId,
  durationMs,
  taskName,
  amount,
  manual,
  sessionCountAfter,
  transition,
  createdAtMs,
  daily,
  project
}) {
  return {
    schemaVersion: 1,
    sessionId,
    stage: TIMER_STAGE.FOCUS,
    durationMs,
    taskName,
    amount,
    manual: !!manual,
    sessionCountAfter,
    transition,
    status: "prepared",
    createdAtMs,
    daily,
    project
  };
}

module.exports = {
  buildNextStageTransition,
  buildDailySettlementPlan,
  buildSettlementJournal,
  validateSettlementJournal
};
