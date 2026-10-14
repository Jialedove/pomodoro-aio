const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeClock, createPlugin } = require("./support.cjs");
const { DEFAULT_LIGHT_PROGRAMS, normalizeLightProgram, createLightingSnapshot, normalizeBridgeUrl } = require("../src/core/lighting");
const { normalizeModuleDefinition, createModuleRunSnapshot } = require("../src/core/modules");
const { normalizeCurrentSettings } = require("../src/core/settings");
const { normalizeModuleRun } = require("../src/core/runtime");
const { LightingClient } = require("../src/integrations/lighting-client");

const clone = value => JSON.parse(JSON.stringify(value));
function runtime(epoch = "run-1", status = "running") {
  return { status, sessionId:epoch, durationMs:1500000, elapsedMs:0,
    moduleRun:{ lighting:{ deviceId:"lamp", baseUrl:"http://127.0.0.1:18473", program:clone(DEFAULT_LIGHT_PROGRAMS[0]) } } };
}
function fixture(options = {}) {
  const calls = [];
  let live = null;
  const client = new LightingClient({ ...options, requestFn:async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method:init.method, body });
    if (url.endsWith("/sync")) live = { deviceId:body.deviceId || "lamp", clientId:body.clientId, epoch:body.epoch, status:body.status, programName:body.program.name, step:1 };
    if (url.endsWith("/release")) live = null;
    return { ok:true, status:200, json:async () => url.endsWith("/program-runs") ? (live ? [live] : []) : live || {} };
  } });
  return { calls, client, posts:() => calls.filter(call => call.method === "POST"), forget:() => { live = null; } };
}

test("灯光绑定支持继承、不联动和稳定模块标识", () => {
  const settings = normalizeCurrentSettings({ modules:[] });
  assert.equal(createLightingSnapshot({ type:"work" }, settings).program.id, "work");
  assert.equal(createLightingSnapshot({ type:"rest" }, settings).program.id, "rest");
  assert.equal(createLightingSnapshot({ type:"work", lightProgramId:"none" }, settings), null);
  assert.equal(createLightingSnapshot({ type:"work", lightProgramId:"missing" }, settings), null);
  assert.equal(normalizeModuleDefinition({ id:"stable", name:"改名", lightProgramId:"reading" }).lightProgramId, "reading");
});

test("任务开始时复制方案内容，编辑库和重载不改变本段", () => {
  const settings = normalizeCurrentSettings({ modules:[] });
  const run = createModuleRunSnapshot({ id:"work", type:"work", name:"阅读" }, {}, { settings });
  settings.lightingPrograms[0].steps[0].target.brightnessPct = 10;
  const restored = normalizeModuleRun(clone(run));
  assert.equal(run.lighting.program.steps[0].target.brightnessPct, 80);
  assert.equal(restored.lighting.program.steps[0].target.brightnessPct, 80);
  assert.equal(restored.lighting.baseUrl, "http://127.0.0.1:18473");
});

test("损坏步骤和非法服务地址不能进入执行快照", () => {
  const program = clone(DEFAULT_LIGHT_PROGRAMS[0]);
  program.steps[0].target.brightnessPct = 101;
  assert.throws(() => normalizeLightProgram(program), /亮度/);
  program.steps[0].target.brightnessPct = 80; program.steps[0].trigger.value = 10;
  assert.throws(() => normalizeLightProgram(program), /基础灯光/);
  assert.throws(() => normalizeBridgeUrl("file:///etc/passwd"));
  assert.throws(() => normalizeBridgeUrl("http://name:secret@localhost"));
});

test("新任务发送完整方案，普通 tick 不重复设置，心跳续期", async () => {
  const clock = new FakeClock(10000);
  const { client, posts } = fixture();
  await clock.run(() => client.syncFromRuntime(runtime()));
  clock.advance(1000); await clock.run(() => client.syncFromRuntime(runtime(), { elapsedMs:1000 }));
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.program.id, "work");
  clock.advance(15000); await clock.run(() => client.syncFromRuntime(runtime(), { elapsedMs:16000 }));
  assert.equal(posts().length, 2);
  assert.ok(posts()[1].body.sequence > posts()[0].body.sequence);
  assert.equal(posts()[1].body.elapsedMs, 16000);
  await client.dispose();
});

test("暂停与恢复发送同一任务进度，重置只调用真正的释放接口", async () => {
  const { client, posts } = fixture();
  await client.syncFromRuntime(runtime());
  await client.syncFromRuntime(runtime("run-1", "paused"), { elapsedMs:5000 });
  await client.syncFromRuntime(runtime(), { elapsedMs:5000 });
  assert.deepEqual(posts().map(call => call.body.status), ["running", "paused", "running"]);
  await client.syncFromRuntime({ status:"idle" });
  assert.equal(posts().at(-1).url.endsWith("/program-runs/release"), true);
  assert.equal(posts().some(call => call.url.endsWith("/control/release")), false);
  await client.dispose();
});

test("全局关闭停止已有编排，开启后可以继续同一任务", async () => {
  const { client, posts } = fixture();
  await client.syncFromRuntime(runtime());
  client.configure({ lightingEnabled:false });
  await client.syncFromRuntime(runtime());
  assert.equal(posts().at(-1).body.epoch, "run-1");
  assert.equal(client.status.status, "disabled");
  client.configure({ lightingEnabled:true });
  await client.syncFromRuntime(runtime());
  assert.equal(posts().at(-1).url.endsWith("/sync"), true);
  await client.dispose();
});

test("服务重启丢失运行状态后，同一任务重新对齐而非永久去重", async () => {
  const clock = new FakeClock(10000);
  const { client, posts, forget } = fixture();
  await clock.run(() => client.syncFromRuntime(runtime()));
  forget(); clock.advance(2000);
  await clock.run(() => client.syncFromRuntime(runtime(), { elapsedMs:2000 }));
  await clock.run(() => client.syncFromRuntime(runtime(), { elapsedMs:2000 }));
  assert.equal(posts().length, 2);
  assert.equal(posts()[1].body.elapsedMs, 2000);
  await client.dispose();
});

test("灯光失败不阻塞计时，失败退避后同一任务可重试", async () => {
  const clock = new FakeClock(10000);
  let requests = 0;
  const client = new LightingClient({ requestFn:async () => {
    requests += 1;
    if (requests === 1) throw new Error("offline");
    return { ok:true, json:async () => ({ status:"running", deviceId:"lamp" }) };
  } });
  await clock.run(() => client.syncFromRuntime(runtime()));
  assert.equal(client.status.status, "error");
  await clock.run(() => client.syncFromRuntime(runtime()));
  // Status polling is read-only; no second control attempt until backoff expires.
  clock.advance(5001); await clock.run(() => client.syncFromRuntime(runtime(), { elapsedMs:5001 }));
  assert.equal(client.status.status, "running");
  await client.dispose();
});

test("未发送的旧任务会被暂停和重置取消，卸载释放本次租约", async () => {
  const calls = [];
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const client = new LightingClient({ requestFn:async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    if (calls.length === 1) await wait;
    return { ok:true, json:async () => ({ status:body.status, deviceId:"lamp" }) };
  } });
  const first = client.syncFromRuntime(runtime("old"));
  await new Promise(resolve => { setImmediate(resolve); });
  const unsent = client.syncFromRuntime(runtime("unsent"));
  const stopped = client.syncFromRuntime({ status:"idle" });
  finish(); await Promise.all([first, unsent, stopped]);
  assert.equal(calls.filter(call => call.url.endsWith("/sync")).length, 1);
  assert.equal(calls.at(-1).body.epoch, "old");
  await client.dispose(); await client.syncFromRuntime(runtime("after-unload"));
  assert.equal(calls.length, 2);
});

test("真实模块启动、改名与下次执行保留正确灯光绑定", async () => {
  const plugin = createPlugin({ settings:{ modules:[{ id:"task", type:"work", name:"阅读", durationMin:25, blackout:false, lightProgramId:"reading" }],
    lightingPrograms:clone(DEFAULT_LIGHT_PROGRAMS), lightingBaseUrl:"http://127.0.0.1:18473", lightingDeviceId:"lamp", projectAssignments:{}, loopMode:"once", autoAdvance:false } });
  await plugin.startSequence();
  assert.equal(plugin.runtime.moduleRun.lighting.program.id, "reading");
  await plugin.updateModule("task", { name:"写作", lightProgramId:"warm" });
  assert.equal(plugin.runtime.moduleRun.lighting.program.id, "reading");
  await plugin.reset(false); await plugin.startSequence();
  assert.equal(plugin.runtime.moduleRun.lighting.program.id, "warm");
});

test("自然完成标记结束提示，提前重置和卸载仅取消", async () => {
  const clock = new FakeClock(10000);
  const { client, posts } = fixture();
  const run = { ...runtime(), durationMs:10000 };
  await clock.run(() => client.syncFromRuntime(run));
  clock.advance(10000); await clock.run(() => client.syncFromRuntime({status:"awaiting"}));
  assert.equal(posts().at(-1).body.completed, true);
  await clock.run(() => client.syncFromRuntime({ ...run, sessionId:"early" }));
  clock.advance(1000); await clock.run(() => client.syncFromRuntime({status:"idle"}));
  assert.equal(posts().at(-1).body.completed, false);
  await client.dispose();
});
