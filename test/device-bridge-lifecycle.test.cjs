const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeClock, createPlugin } = require("./support.cjs");

test("运行中 tick 重新同步设备以允许同一模块离线恢复", async () => {
  const clock = new FakeClock(10_000);
  const plugin = createPlugin({ settings:{
    modules:[{ id:"work", type:"work", name:"阅读", durationMin:25, blackout:false }],
    projectAssignments:{}, loopMode:"once", autoAdvance:false, enableProjects:false
  } });
  const synced = [];
  plugin.deviceBridge = { syncFromRuntime:async runtime => { synced.push(runtime.sessionId); } };
  await clock.run(() => plugin.startSequence());
  synced.length = 0;
  clock.advance(1_000);
  await clock.run(() => plugin.tick());
  assert.deepEqual(synced, [plugin.runtime.sessionId]);
});

test("插件卸载等待设备适配器销毁并停止后续 tick 同步", async () => {
  const plugin = createPlugin();
  const calls = [];
  plugin.deviceBridge = {
    syncFromRuntime:async () => { calls.push("sync"); },
    releaseControl:async () => { calls.push("release"); },
    dispose:async () => { await Promise.resolve(); calls.push("disposed"); }
  };
  await plugin.onunload();
  plugin._syncDeviceBridge();
  assert.deepEqual(calls, ["disposed"]);
});

test("转换尚未保存时 tick 不发送未提交的设备状态", async () => {
  const clock = new FakeClock(10_000);
  const plugin = createPlugin({ settings:{
    modules:[{ id:"work", type:"work", name:"阅读", durationMin:25, blackout:false }],
    projectAssignments:{}, loopMode:"once", autoAdvance:false, enableProjects:false
  } });
  const synced = [];
  plugin.deviceBridge = { syncFromRuntime:async runtime => { synced.push(runtime.sessionId); } };
  await clock.run(() => plugin.startSequence());
  synced.length = 0;
  const previous = plugin.runtime;
  plugin.runtime = { ...previous, sessionId:"uncommitted" };
  let finishSave;
  plugin.saveState = () => new Promise(resolve => { finishSave = resolve; });
  const transition = plugin.saveTransition(previous);
  await clock.run(() => plugin.tick());
  assert.deepEqual(synced, []);
  finishSave();
  await transition;
  assert.deepEqual(synced, ["uncommitted"]);
});
