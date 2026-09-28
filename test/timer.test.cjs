const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TIMER_STATUS,
  TIMER_STAGE,
  plannedTomatoAmount,
  actualTomatoAmount,
  getElapsedMs,
  getRemainingMs
} = require("../src/core/timer.js");
const { configuredStageDurationMs } = require("../src/legacy/timer.js");

test("timer 纯函数按毫秒计算阶段时长和番茄额度", () => {
  assert.equal(configuredStageDurationMs({ focusMin: 15 }, TIMER_STAGE.FOCUS), 900_000);
  assert.equal(configuredStageDurationMs({ breakMin: 5, longBreakMin: 15 }, TIMER_STAGE.BREAK), 300_000);
  assert.equal(configuredStageDurationMs({ breakMin: 5, longBreakMin: 15 }, TIMER_STAGE.BREAK, true), 900_000);
  assert.equal(configuredStageDurationMs({ cycleMinA: 15, cycleMinB: 30 }, TIMER_STAGE.FOCUS, false, 1), 1_800_000);
  assert.equal(configuredStageDurationMs({ breakMin: 5 }, TIMER_STAGE.BREAK, true), 900_000);
  assert.equal(configuredStageDurationMs({ cycleMinA: 15 }, TIMER_STAGE.FOCUS, false, 1), 900_000);
  assert.deepEqual([15, 25, 30, 50].map(minutes => plannedTomatoAmount(minutes * 60_000)), [0.6, 1, 1.2, 2]);
  assert.equal(actualTomatoAmount(0), 0);
  assert.equal(actualTomatoAmount(5 * 60_000), 0.2);
});

test("timer 纯函数按运行态计算有效时间，不引入暂停漂移", () => {
  const running = {
    status: TIMER_STATUS.RUNNING,
    durationMs: 3_600_000,
    startedAtMs: 1_000,
    elapsedMs: 123
  };
  assert.equal(getElapsedMs(running, 2_234), 1_357);
  assert.equal(getRemainingMs(running, { focusMin: 25 }, 2_234), 3_598_643);

  const paused = { ...running, status: TIMER_STATUS.PAUSED, remainingMs: 3_000_000 };
  assert.equal(getElapsedMs(paused, 100_000), 123);
  assert.equal(getRemainingMs(paused, { focusMin: 25 }, 100_000), 3_000_000);
  assert.equal(getRemainingMs({ status: TIMER_STATUS.AWAITING, attention: { durationMs: 900_000 } }, {}, 0), 900_000);
});
