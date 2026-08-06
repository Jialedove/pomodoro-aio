const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildNextStageTransition,
  buildDailySettlementPlan,
  buildSettlementJournal,
  validateSettlementJournal
} = require("../src/core/settlement.js");

const settings = {
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  longEvery: 4,
  autoNext: true,
  cycleMinA: 15,
  cycleMinB: 30,
  fmKey: "番茄数"
};

test("settlement 纯函数计算普通模式的短休、长休和自动衔接", () => {
  assert.deepEqual(
    buildNextStageTransition(settings, { mode: "standard" }, 3),
    { mode: "standard", isLong: false, autoNext: true, durationMs: 300_000 }
  );
  assert.deepEqual(
    buildNextStageTransition(settings, { mode: "standard" }, 4),
    { mode: "standard", isLong: true, autoNext: true, durationMs: 900_000 }
  );
});

test("settlement 纯函数计算循环模式的下一槽位", () => {
  assert.deepEqual(
    buildNextStageTransition(settings, { mode: "cycle", cycleSlot: 0 }, 1),
    { mode: "cycle", cycleSlot: 1, taskName: "", autoNext: false, durationMs: 1_800_000 }
  );
  assert.deepEqual(
    buildNextStageTransition(settings, { mode: "cycle", cycleSlot: 1 }, 1),
    { mode: "cycle", cycleSlot: 0, taskName: "", autoNext: false, durationMs: 900_000 }
  );
});

test("settlement 纯函数组装日记计划和可恢复 journal", () => {
  const daily = buildDailySettlementPlan("- [ ] 写报告 0🍅\n", {
    path: "Daily/today.md",
    taskName: "写报告",
    amount: 0.2,
    settings: { allowAutoCreateTask: true, tasksHeading: "" },
    frontmatterKey: "番茄数"
  });
  const journal = buildSettlementJournal({
    sessionId: "session-1",
    durationMs: 300_000,
    taskName: "写报告",
    amount: 0.2,
    manual: true,
    sessionCountAfter: 1,
    transition: { mode: "standard", isLong: false, autoNext: false, durationMs: 300_000 },
    createdAtMs: 123,
    daily,
    project: { path: "", key: "番茄数", amount: 0.2, status: "skipped" }
  });

  assert.equal(daily.rowStatus, "pending");
  assert.equal(daily.frontmatterStatus, "pending");
  assert.equal(daily.lineAfter, "- [ ] 写报告 0.2🍅");
  assert.equal(journal.status, "prepared");
  assert.equal(journal.sessionId, "session-1");
  assert.equal(journal.daily, daily);
  assert.deepEqual(journal.project, { path: "", key: "番茄数", amount: 0.2, status: "skipped" });
  assert.equal(validateSettlementJournal(journal), null);
  for (const invalid of [
    { ...journal, schemaVersion: 2 },
    { ...journal, amount: 0 },
    { ...journal, status: "broken" },
    { ...journal, transition: null },
    { ...journal, daily: { ...daily, path: "" } },
    { ...journal, daily: { ...daily, lineAfter: "" } }
  ]) assert.ok(validateSettlementJournal(invalid));
});
