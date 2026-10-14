const test = require("node:test");
const assert = require("node:assert/strict");
// support 先用假 obsidian 加载插件，后面 require 的控制器复用同一模块缓存。
const { createPlugin } = require("./support.cjs");
const {
  ACTIVITY_NUDGE_DEFAULTS,
  normalizeActivityNudgeSettings,
  createNudgeState,
  untrackedReason,
  evaluateNudge,
  snoozeNudge,
  parseHidIdleSeconds
} = require("../src/core/activity-nudge.js");
const { normalizeCurrentSettings } = require("../src/core/settings.js");
const { SystemActivityMonitor } = require("../src/integrations/system-activity.js");
const { ActivityNudgeController } = require("../src/controllers/activity-nudge-controller.js");

const MIN = 60_000;
const settings = { ...ACTIVITY_NUDGE_DEFAULTS, activityGentleAfterMin:1, activityStrongAfterMin:5, activityStrongRepeatMin:5, activityAwaySec:120 };

/** 每次以 idleSec 推进到 nowMs，返回动作序列。 */
function drive(steps, state = createNudgeState(), extra = {}) {
  const actions = [];
  for (const [nowMs, idleSec] of steps) {
    const decision = evaluateNudge(state, { nowMs, idleSec, untracked:true, settings, ...extra });
    state = decision.state;
    actions.push(decision.action);
  }
  return { actions, state };
}

test("连续使用先轻提醒一次，到时强提醒，并按间隔重复", () => {
  const { actions } = drive([[0, 1], [0.5 * MIN, 1], [1 * MIN, 1], [2 * MIN, 1], [5 * MIN, 1], [7 * MIN, 1], [10 * MIN, 1]]);
  assert.deepEqual(actions, ["none", "none", "gentle", "none", "strong", "none", "strong"]);
});

test("离开超过阈值后重新计算连续使用时间", () => {
  const { actions } = drive([[0, 1], [4 * MIN, 1], [4.5 * MIN, 130], [5 * MIN, 1], [6 * MIN, 1], [9 * MIN, 1], [10 * MIN, 1]]);
  assert.deepEqual(actions, ["none", "gentle", "none", "none", "gentle", "none", "strong"]);
});

test("正在计时、关闭提醒或读不到空闲时间时不提醒并清空计数", () => {
  const busy = drive([[0, 1], [6 * MIN, 1]], createNudgeState(), { untracked:false });
  assert.deepEqual(busy.actions, ["none", "none"]);
  assert.equal(busy.state.activeSinceMs, null);
  const off = drive([[0, 1], [6 * MIN, 1]], createNudgeState(), { settings:{ ...settings, activityNudgeEnabled:false } });
  assert.deepEqual(off.actions, ["none", "none"]);
  assert.deepEqual(drive([[0, null], [6 * MIN, null]]).actions, ["none", "none"]);
});

test("稍后提醒期间静默，结束后从头计算", () => {
  const started = drive([[0, 1], [5 * MIN, 1]]);
  assert.equal(started.actions[1], "strong");
  const snoozed = snoozeNudge(started.state, 5 * MIN, 15);
  const { actions } = drive([[10 * MIN, 1], [20 * MIN, 1], [21 * MIN, 1], [25 * MIN, 1]], snoozed);
  assert.deepEqual(actions, ["none", "none", "gentle", "strong"]);
});

test("只有空闲或暂停算未计时；等待确认与结算中不打扰", () => {
  assert.equal(untrackedReason({ status:"idle", attention:null }), "idle");
  assert.equal(untrackedReason({ status:"paused", attention:null }), "paused");
  assert.equal(untrackedReason({ status:"running", attention:null }), null);
  assert.equal(untrackedReason({ status:"awaiting", attention:{ type:"focus" } }), null);
  assert.equal(untrackedReason({ status:"idle", attention:{ type:"focus" } }), null);
  assert.equal(untrackedReason({ status:"idle", attention:null, pendingSettlement:{ id:"x" } }), null);
  assert.equal(untrackedReason({ status:"settlement-failed", attention:null }), null);
});

test("设置规范化给出默认值并限制下限", () => {
  const normalized = normalizeCurrentSettings({ activityGentleAfterMin:"abc", activityStrongAfterMin:0.01, activityAwaySec:3, activityNudgeEnabled:false });
  assert.equal(normalized.activityNudgeEnabled, false);
  assert.equal(normalized.activityGentleAfterMin, 1);
  assert.equal(normalized.activityStrongAfterMin, 0.5);
  assert.equal(normalized.activityAwaySec, 10);
  assert.equal(normalized.activitySnoozeMin, 15);
  assert.deepEqual(normalizeActivityNudgeSettings({}), { ...ACTIVITY_NUDGE_DEFAULTS });
});

test("解析 ioreg 的 HIDIdleTime 纳秒值", () => {
  assert.equal(parseHidIdleSeconds('    |   "HIDIdleTime" = 412511865750\n'), 412.51186575);
  assert.equal(parseHidIdleSeconds("no idle here"), null);
});

function fakeDocument() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    fire(type) { listeners.get(type)?.(); }
  };
}

test("macOS 读取系统空闲时间，连续失败后退回窗口内输入", async () => {
  let now = 0;
  let fail = false;
  const calls = [];
  const document = fakeDocument();
  const monitor = new SystemActivityMonitor({
    platform:"darwin", document, now:() => now,
    execFile:async (command, args) => {
      calls.push([command, ...args]);
      if (fail) throw new Error("ioreg missing");
      return '"HIDIdleTime" = 3000000000';
    }
  });
  assert.equal(await monitor.readIdleSeconds(), 3);
  assert.equal(calls[0][0], "/usr/sbin/ioreg");
  fail = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    now = 10_000;
    for (let i = 0; i < 3; i += 1) await monitor.readIdleSeconds();
    assert.equal(monitor.usesSystemIdle, false);
    document.fire("keydown");
    now = 14_000;
    assert.equal(await monitor.readIdleSeconds(), 4);
    assert.equal(calls.length, 4);
  } finally {
    console.warn = warn;
  }
  monitor.dispose();
  assert.equal(document.listeners.size, 0);
});

test("非 macOS 只用窗口内输入，强提醒不调用 open", async () => {
  let now = 0;
  const calls = [];
  const document = fakeDocument();
  const monitor = new SystemActivityMonitor({ platform:"linux", document, now:() => now, execFile:async (...args) => { calls.push(args); return ""; } });
  now = 7000;
  assert.equal(await monitor.readIdleSeconds(), 7);
  globalThis.window = globalThis.window || { focus() {} };
  await monitor.activateObsidian();
  assert.equal(calls.length, 0);
});

function controllerFor(plugin, idleSec, clock) {
  const events = [];
  const controller = new ActivityNudgeController(plugin, {
    monitor:{ readIdleSeconds:async () => idleSec(), activateObsidian:async () => { events.push("activate"); }, dispose() {} },
    timers:{ setInterval:() => 1, clearInterval() {}, setTimeout:() => 1, clearTimeout() {} },
    playBeep:(kind, enabled, waveform, strong) => events.push(strong ? "beep-strong" : "beep"),
    sysNotify:() => events.push("notify"),
    logPluginError:() => {},
    now:() => clock.value
  });
  return { controller, events };
}

test("控制器按判定发轻提醒和强提醒，开始计时后停止", async () => {
  const plugin = createPlugin({ settings:{ ...settings, enableSound:true, enableNotify:true } });
  plugin.runtime.status = "idle";
  plugin.runtime.attention = null;
  const opened = [];
  plugin.openActivityNudgeModal = (reason, activeMin) => opened.push([reason, activeMin]);
  const clock = { value:0 };
  const { controller, events } = controllerFor(plugin, () => 1, clock);
  for (const t of [0, 1, 2, 5]) { clock.value = t * MIN; await controller.poll(); }
  assert.deepEqual(events, ["notify", "beep", "beep-strong", "activate"]);
  assert.deepEqual(opened, [["idle", 5]]);
  plugin.runtime.status = "running";
  clock.value = 20 * MIN;
  await controller.poll();
  assert.equal(events.length, 4);
  assert.equal(controller.state.activeSinceMs, null);
});

test("从提醒弹窗开始工作会写入事情名称并从该工作模块开始", async () => {
  const plugin = createPlugin({ settings:{
    modules:[
      { id:"rest-1", type:"rest", name:"散步", durationMin:5, blackout:false },
      { id:"work-1", type:"work", name:"工作", durationMin:25, blackout:false }
    ],
    projectAssignments:{}, loopMode:"once", loopCount:1, autoAdvance:false,
    enableProjects:false, enableNotify:false, enableSound:false
  } });
  const started = [];
  plugin.startSequence = async index => { started.push(index); return true; };
  assert.equal(await plugin.startWorkFromNudge("work-1", "  写周报 "), true);
  assert.equal(plugin.settings.modules[1].name, "写周报");
  assert.deepEqual(started, [1]);
  assert.equal(await plugin.startWorkFromNudge("rest-1", "x"), false);
  plugin.runtime.status = "running";
  assert.equal(await plugin.startWorkFromNudge("work-1", "写周报"), false);
  assert.deepEqual(started, [1]);
});
