const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { RUNTIME_EVENT, RUNTIME_EFFECT, reduceRuntime } = require("../src/core/state-machine");

const BASE_RUNTIME = {
  status:"idle",
  stage:null,
  mode:"standard",
  cycleSlot:0,
  durationMs:0,
  startedAtMs:0,
  elapsedMs:0,
  remainingMs:0,
  pausedAtMs:0,
  sessionId:null,
  plannedTomatoCredit:0,
  attention:null,
  pendingSettlement:null,
  pendingBreakTransition:null,
  breakContinuation:null,
  sessionCount:0,
  cycleRoundCount:0,
  currentTaskName:"任务",
  longFocusMinutes:50,
  failure:null
};

test("runtime reducer 纯函数完成开始、暂停和继续转换", () => {
  const before = structuredClone(BASE_RUNTIME);
  const started = reduceRuntime(before, {
    type:RUNTIME_EVENT.START_STAGE,
    stage:"focus",
    durationMs:1_500_000,
    now:10_000,
    sessionId:"session",
    mode:"cycle",
    cycleSlot:1,
    currentTaskName:"B"
  });

  assert.deepEqual(before, BASE_RUNTIME);
  assert.equal(started.runtime.status, "running");
  assert.equal(started.runtime.stage, "focus");
  assert.equal(started.runtime.plannedTomatoCredit, 1);
  assert.equal(started.runtime.currentTaskName, "B");
  assert.deepEqual(started.effects, [RUNTIME_EFFECT.ALERT_STOP, RUNTIME_EFFECT.BROADCAST, RUNTIME_EFFECT.RESYNC]);

  const paused = reduceRuntime(started.runtime, { type:RUNTIME_EVENT.PAUSE, now:20_000, elapsedMs:10_000 });
  assert.equal(paused.runtime.status, "paused");
  assert.equal(paused.runtime.remainingMs, 1_490_000);
  assert.equal(started.runtime.status, "running");

  const resumed = reduceRuntime(paused.runtime, { type:RUNTIME_EVENT.RESUME, now:30_000 });
  assert.equal(resumed.runtime.status, "running");
  assert.equal(resumed.runtime.startedAtMs, 30_000);
  assert.equal(resumed.runtime.remainingMs, 1_490_000);
});

test("runtime reducer 统一提醒、结算、恢复和重置不变量", () => {
  const attention = { type:"break", isLong:false, cycleSlot:null, nextStarted:false, durationMs:300_000 };
  let state = reduceRuntime({ ...BASE_RUNTIME, status:"running", stage:"focus", durationMs:1_500_000, startedAtMs:1 }, {
    type:RUNTIME_EVENT.SET_ATTENTION,
    attention
  });
  assert.equal(state.runtime.status, "awaiting");
  assert.equal(state.runtime.stage, null);
  assert.equal(state.runtime.remainingMs, 300_000);
  assert.deepEqual(state.effects, [RUNTIME_EFFECT.ALERT_START, RUNTIME_EFFECT.BROADCAST]);

  state = reduceRuntime(state.runtime, { type:RUNTIME_EVENT.BEGIN_FOCUS_SETTLEMENT, sessionId:"focus-session" });
  assert.equal(state.runtime.status, "settling");
  assert.equal(state.runtime.attention, null);

  const journal = { sessionId:"focus-session", status:"prepared", durationMs:1_500_000, sessionCountAfter:2 };
  state = reduceRuntime(state.runtime, { type:RUNTIME_EVENT.SET_PENDING_SETTLEMENT, journal });
  state = reduceRuntime(state.runtime, { type:RUNTIME_EVENT.RESUME_SETTLEMENT, journal });
  state = reduceRuntime(state.runtime, { type:RUNTIME_EVENT.FINALIZE_SETTLEMENT, journal });
  assert.equal(state.runtime.sessionCount, 2);
  assert.equal(state.runtime.stage, "focus");

  const transition = { status:"break-completing", autoNext:true, durationMs:1_500_000 };
  state = reduceRuntime(state.runtime, { type:RUNTIME_EVENT.BEGIN_BREAK_TRANSITION, transition });
  assert.equal(state.runtime.pendingBreakTransition, transition);
  assert.equal(state.runtime.status, "settling");

  state = reduceRuntime(state.runtime, { type:RUNTIME_EVENT.RESET, mode:"standard" });
  assert.equal(state.runtime.status, "idle");
  assert.equal(state.runtime.pendingBreakTransition, null);
  assert.equal(state.runtime.attention, null);
});

test("插件入口不直接写计时阶段字段", () => {
  const source = fs.readFileSync("src/main.js", "utf8");
  const fields = "status|stage|mode|cycleSlot|durationMs|startedAtMs|elapsedMs|remainingMs|pausedAtMs|sessionId|plannedTomatoCredit|attention|pendingSettlement|pendingBreakTransition|failure";
  assert.doesNotMatch(source, new RegExp(`this\\.runtime\\.(?:${fields})\\s*=(?!=)`));
  assert.doesNotMatch(source, new RegExp(`\\br\\.(?:${fields})\\s*=(?!=)`));
});
