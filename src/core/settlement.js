const { TIMER_STAGE, configuredStageDurationMs } = require("./timer");
const { planTaskLineMutation } = require("./task-lines");

function buildNextStageTransition(settings, runtime, sessionCountAfter) {
  if (runtime?.mode === "cycle") {
    const cycleSlot = runtime.cycleSlot === 1 ? 0 : 1;
    const taskName = cycleSlot === 1 ? settings.cycleTaskB : settings.cycleTaskA;
    return {
      mode: "cycle",
      cycleSlot,
      taskName: String(taskName || "").trim(),
      autoNext: false,
      durationMs: configuredStageDurationMs(settings, TIMER_STAGE.FOCUS, false, cycleSlot)
    };
  }
  const isLong = settings.longEvery > 0 && sessionCountAfter % settings.longEvery === 0;
  return {
    mode: "standard",
    isLong,
    autoNext: !!settings.autoNext,
    durationMs: configuredStageDurationMs(settings, TIMER_STAGE.BREAK, isLong)
  };
}

function buildDailySettlementPlan(sourceText, { path, taskName, amount, settings, frontmatterKey }) {
  const daily = planTaskLineMutation(sourceText, taskName, amount, settings);
  return Object.assign(daily, {
    path,
    taskName,
    frontmatterKey: frontmatterKey || "番茄数",
    rowStatus: "pending",
    frontmatterStatus: "pending"
  });
}

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
  buildSettlementJournal
};
