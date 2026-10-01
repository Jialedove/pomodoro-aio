const test = require("node:test");
const assert = require("node:assert/strict");
const { projectRuntimeToBridgeAction, DeviceBridgeAdapter } = require("../src/integrations/device-bridge");
const { TIMER_STATUS, TIMER_STAGE } = require("../src/core/timer");

test("Task 5: projection maps runtime states to device bridge actions", () => {
  // 1. WORK state projection
  const workRuntime = {
    status: TIMER_STATUS.RUNNING,
    stage: TIMER_STAGE.FOCUS,
    sessionId: "session-work-101",
    moduleRun: { type: "work", name: "深度工作" }
  };
  const workAction = projectRuntimeToBridgeAction(workRuntime);
  assert.equal(workAction.type, "APPLY_PROFILE");
  assert.equal(workAction.profileId, "work");
  assert.equal(workAction.epoch, "session-work-101");

  // 2. REST state projection (off)
  const restRuntime = {
    status: TIMER_STATUS.RUNNING,
    stage: TIMER_STAGE.BREAK,
    sessionId: "session-rest-102",
    moduleRun: { type: "rest", name: "休息" }
  };
  const restAction = projectRuntimeToBridgeAction(restRuntime);
  assert.equal(restAction.type, "APPLY_PROFILE");
  assert.equal(restAction.profileId, "rest");
  assert.equal(restAction.epoch, "session-rest-102");

  // 3. PAUSED state projection (hold)
  const pausedRuntime = {
    status: TIMER_STATUS.PAUSED,
    stage: TIMER_STAGE.FOCUS,
    sessionId: "session-work-101"
  };
  const pausedAction = projectRuntimeToBridgeAction(pausedRuntime);
  assert.equal(pausedAction.type, "HOLD");
  assert.equal(pausedAction.epoch, "session-work-101");

  // 4. RESET / IDLE state projection (release)
  const idleRuntime = {
    status: TIMER_STATUS.IDLE,
    sessionId: null
  };
  const idleAction = projectRuntimeToBridgeAction(idleRuntime);
  assert.equal(idleAction.type, "RELEASE");
});

test("Task 5 & 6: DeviceBridgeAdapter invokes API and handles deduplication", async () => {
  const requests = [];
  const mockRequestFn = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({}) };
  };

  const adapter = new DeviceBridgeAdapter({
    baseUrl: "http://127.0.0.1:18473",
    clientId: "pomodoro-aio",
    requestFn: mockRequestFn
  });

  // Step 1: Start WORK
  await adapter.syncFromRuntime({
    status: TIMER_STATUS.RUNNING,
    stage: TIMER_STAGE.FOCUS,
    sessionId: "epoch-work-1",
    moduleRun: { type: "work" }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:18473/v1/profiles/work/apply");
  assert.equal(requests[0].body.clientId, "pomodoro-aio");
  assert.equal(requests[0].body.epoch, "epoch-work-1");

  // Step 2: Same state tick -> Deduplicated, no extra HTTP call
  await adapter.syncFromRuntime({
    status: TIMER_STATUS.RUNNING,
    stage: TIMER_STAGE.FOCUS,
    sessionId: "epoch-work-1",
    moduleRun: { type: "work" }
  });
  assert.equal(requests.length, 1, "Duplicate runtime states must not trigger redundant API calls");

  // Step 3: PAUSED -> Hold state, no API call
  await adapter.syncFromRuntime({
    status: TIMER_STATUS.PAUSED,
    stage: TIMER_STAGE.FOCUS,
    sessionId: "epoch-work-1"
  });
  assert.equal(requests.length, 1, "PAUSED must hold without sending network calls");

  // Step 4: Next module REST (epoch-2) -> New epoch starts!
  await adapter.syncFromRuntime({
    status: TIMER_STATUS.RUNNING,
    stage: TIMER_STAGE.BREAK,
    sessionId: "epoch-rest-2",
    moduleRun: { type: "rest" }
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "http://127.0.0.1:18473/v1/profiles/rest/apply");
  assert.equal(requests[1].body.epoch, "epoch-rest-2");

  // Step 5: RESET -> release control
  await adapter.syncFromRuntime({
    status: TIMER_STATUS.IDLE
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, "http://127.0.0.1:18473/v1/control/release");
});

test("Task 5: DeviceBridgeAdapter network failures are fail-soft", async () => {
  const failingRequestFn = async () => {
    throw new Error("ECONNREFUSED: Server not running");
  };

  const adapter = new DeviceBridgeAdapter({
    baseUrl: "http://127.0.0.1:18473",
    requestFn: failingRequestFn
  });

  // Must not throw or crash
  await assert.doesNotReject(async () => {
    await adapter.syncFromRuntime({
      status: TIMER_STATUS.RUNNING,
      stage: TIMER_STAGE.FOCUS,
      sessionId: "epoch-fail-test",
      moduleRun: { type: "work" }
    });
  });
});
