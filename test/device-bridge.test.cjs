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

  // Step 5: RESET -> release local automation without clearing the user's override
  await adapter.syncFromRuntime({
    status: TIMER_STATUS.IDLE
  });
  assert.equal(requests.length, 2);
});

const workRuntime = (sessionId = "work-epoch") => ({
  status: TIMER_STATUS.RUNNING,
  stage: TIMER_STAGE.FOCUS,
  sessionId,
  moduleRun: { type: "work" }
});

test("Device Bridge respects the explicit module type and requires a stable epoch", () => {
  assert.equal(projectRuntimeToBridgeAction({
    ...workRuntime(), moduleRun: { type: "rest" }
  }).profileId, "rest", "A stale stage must not turn a rest module into work");
  assert.equal(projectRuntimeToBridgeAction(workRuntime(null)).type, "NONE",
    "Missing session IDs must not fabricate epochs that reset manual override");
});

test("failed Device Bridge requests remain retryable in the same module", async () => {
  let requests = 0;
  const adapter = new DeviceBridgeAdapter({ retryDelayMs: 0, requestFn: async () => {
    requests += 1;
    if (requests === 1) throw new Error("ECONNREFUSED");
    return { ok: true };
  } });
  await adapter.syncFromRuntime(workRuntime());
  await adapter.syncFromRuntime(workRuntime());
  await adapter.syncFromRuntime(workRuntime());
  assert.equal(requests, 2, "Only a successful request may suppress later duplicates");
});

test("HTTP failure does not mark a Device Bridge action as synchronized", async () => {
  let requests = 0;
  const adapter = new DeviceBridgeAdapter({ retryDelayMs: 0, requestFn: async () => {
    requests += 1;
    return requests === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 };
  } });
  await adapter.syncFromRuntime(workRuntime());
  await adapter.syncFromRuntime(workRuntime());
  assert.equal(requests, 2);
});

test("Device Bridge applies module changes in persisted transition order", async () => {
  const calls = [];
  let finishFirst;
  const firstResponse = new Promise(resolve => { finishFirst = resolve; });
  const adapter = new DeviceBridgeAdapter({ requestFn: async (url) => {
    calls.push(url);
    if (calls.length === 1) await firstResponse;
    return { ok: true };
  } });
  const firstSync = adapter.syncFromRuntime(workRuntime("work-1"));
  const secondSync = adapter.syncFromRuntime({
    status: TIMER_STATUS.RUNNING, stage: TIMER_STAGE.BREAK,
    sessionId: "rest-2", moduleRun: { type: "rest" }
  });
  await new Promise(resolve => { setImmediate(resolve); });
  const callsBeforeCompletion = calls.length;
  finishFirst();
  await Promise.all([firstSync, secondSync]);
  assert.equal(callsBeforeCompletion, 1, "The newer module must wait for the previous request");
  assert.deepEqual(calls.map(url => url.split("/").at(-2)), ["work", "rest"]);
});

test("pause and resume preserve the same epoch without reapplying successful automation", async () => {
  const calls = [];
  const adapter = new DeviceBridgeAdapter({ requestFn: async (url) => {
    calls.push(url);
    return { ok: true };
  } });
  await adapter.syncFromRuntime(workRuntime());
  await adapter.syncFromRuntime({ ...workRuntime(), status: TIMER_STATUS.PAUSED });
  await adapter.syncFromRuntime(workRuntime());
  assert.equal(calls.length, 1, "Resume must hold any light changes made while paused");
});

test("pause cancels module actions that have not reached the network", async () => {
  const calls = [];
  let finishFirst;
  const firstResponse = new Promise(resolve => { finishFirst = resolve; });
  const adapter = new DeviceBridgeAdapter({ requestFn: async (url) => {
    calls.push(url);
    if (calls.length === 1) await firstResponse;
    return { ok: true };
  } });
  const firstSync = adapter.syncFromRuntime(workRuntime("work-1"));
  await new Promise(resolve => { setImmediate(resolve); });
  const restRuntime = {
    status: TIMER_STATUS.RUNNING, stage: TIMER_STAGE.BREAK,
    sessionId: "rest-2", moduleRun: { type: "rest" }
  };
  const restSync = adapter.syncFromRuntime(restRuntime);
  await adapter.syncFromRuntime({ ...restRuntime, status: TIMER_STATUS.PAUSED });
  finishFirst();
  await Promise.all([firstSync, restSync]);
  assert.equal(calls.length, 1, "Pending rest automation must hold while paused");
  await adapter.syncFromRuntime(restRuntime);
  assert.equal(calls.length, 2, "Resuming the rest module may apply its profile");
});

test("a stalled Device Bridge request times out and allows later synchronization", async () => {
  let requests = 0;
  const adapter = new DeviceBridgeAdapter({ timeoutMs: 10, retryDelayMs: 0, requestFn: async () => {
    requests += 1;
    if (requests === 1) return new Promise(() => {});
    return { ok: true };
  } });
  await adapter.syncFromRuntime(workRuntime());
  await adapter.syncFromRuntime(workRuntime());
  assert.equal(requests, 2);
  await assert.doesNotReject(adapter.dispose());
});

test("concurrent ticks merge the same in-flight Device Bridge action", async () => {
  let requests = 0;
  let finishFirst;
  const firstResponse = new Promise(resolve => { finishFirst = resolve; });
  const adapter = new DeviceBridgeAdapter({ retryDelayMs: 0, requestFn: async () => {
    requests += 1;
    if (requests === 1) {
      await firstResponse;
      throw new Error("offline");
    }
    return { ok: true };
  } });
  const firstSync = adapter.syncFromRuntime(workRuntime());
  const duplicateSync = adapter.syncFromRuntime(workRuntime());
  await new Promise(resolve => { setImmediate(resolve); });
  finishFirst();
  await Promise.all([firstSync, duplicateSync]);
  assert.equal(requests, 1, "Ticks must not build a duplicate request queue while offline");
  await adapter.syncFromRuntime(workRuntime());
  assert.equal(requests, 2, "A later tick may retry once the previous request has finished");
});

test("Device Bridge backs off offline requests but immediately follows a new module", async () => {
  const calls = [];
  const adapter = new DeviceBridgeAdapter({ retryDelayMs: 20, requestFn: async (url) => {
    calls.push(url);
    throw new Error("offline");
  } });
  await adapter.syncFromRuntime(workRuntime("work-1"));
  await adapter.syncFromRuntime(workRuntime("work-1"));
  assert.equal(calls.length, 1, "Same-module retries must wait for the backoff");
  await adapter.syncFromRuntime({
    status: TIMER_STATUS.RUNNING, stage: TIMER_STAGE.BREAK,
    sessionId: "rest-2", moduleRun: { type: "rest" }
  });
  assert.equal(calls.length, 2, "A new module must not inherit another module's backoff");
  await new Promise(resolve => { setTimeout(resolve, 25); });
  await adapter.syncFromRuntime({
    status: TIMER_STATUS.RUNNING, stage: TIMER_STAGE.BREAK,
    sessionId: "rest-2", moduleRun: { type: "rest" }
  });
  assert.equal(calls.length, 3);
});

test("idle and unload invalidate pending automation without clearing manual override", async () => {
  const calls = [];
  let finishFirst;
  const firstResponse = new Promise(resolve => { finishFirst = resolve; });
  const adapter = new DeviceBridgeAdapter({ requestFn: async (url) => {
    calls.push(url);
    if (url.endsWith("/work/apply")) await firstResponse;
    return { ok: true };
  } });
  await adapter.syncFromRuntime({ status: TIMER_STATUS.IDLE });
  assert.equal(calls.length, 0, "Idle startup must not call the restore-automation endpoint");
  const firstSync = adapter.syncFromRuntime(workRuntime("old"));
  await new Promise(resolve => { setImmediate(resolve); });
  const pendingSync = adapter.syncFromRuntime(workRuntime("pending"));
  const disposed = adapter.dispose();
  finishFirst();
  await Promise.all([firstSync, pendingSync, disposed]);
  await adapter.syncFromRuntime(workRuntime("after-unload"));
  assert.equal(calls.length, 1, "Queued and post-unload automation must remain inactive");
  assert.equal(calls.some(url => url.includes("/control/release")), false);
});

test("reset drops queued automation and allows a later sequence to start", async () => {
  const calls = [];
  let finishFirst;
  const firstResponse = new Promise(resolve => { finishFirst = resolve; });
  const adapter = new DeviceBridgeAdapter({ requestFn: async (url) => {
    calls.push(url);
    if (calls.length === 1) await firstResponse;
    return { ok: true };
  } });
  const firstSync = adapter.syncFromRuntime(workRuntime("old"));
  await new Promise(resolve => { setImmediate(resolve); });
  const pendingSync = adapter.syncFromRuntime(workRuntime("pending"));
  const resetSync = adapter.syncFromRuntime({ status: TIMER_STATUS.IDLE });
  finishFirst();
  await Promise.all([firstSync, pendingSync, resetSync]);
  assert.equal(calls.length, 1, "Reset must discard unsent module requests");
  await adapter.syncFromRuntime(workRuntime("new-sequence"));
  assert.equal(calls.length, 2);
  assert.equal(calls.every(url => url.endsWith("/work/apply")), true);
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
