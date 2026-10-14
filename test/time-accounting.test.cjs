const test = require("node:test");
const assert = require("node:assert/strict");
// support 先用假 obsidian 加载插件，后面 require 的模块复用同一缓存。
const { createPlugin, FakeVault } = require("./support.cjs");
const {
  ACCOUNTING_DEFAULTS,
  normalizeAccountingSettings,
  splitAccountingPatch,
  duePendingPatch,
  createAccountingStore,
  normalizeAccountingStore,
  classifyRuntime,
  advanceAccounting,
  snoozeAccounting,
  declareUntracked,
  endDeclaration,
  createLadderState,
  evaluateLadder,
  parseHidIdleSeconds,
  clockText
} = require("../src/core/time-accounting.js");
const { normalizeCurrentSettings } = require("../src/core/settings.js");
const { SystemActivityMonitor } = require("../src/integrations/system-activity.js");
const { TimeAccountingController } = require("../src/controllers/time-accounting-controller.js");
const { AccountingOverlay } = require("../src/ui/accounting-overlay.js");
const { EventEmitter } = require("node:events");

const MIN = 60_000;
const T0 = new Date(2026, 9, 14, 9, 0, 0).getTime();
const at = minutes => T0 + minutes * MIN;
const settings = { ...ACCOUNTING_DEFAULTS };
const DAY = "2026-10-14";
const PATH = "Daily/2026-10-14.md";

/** 按 [分钟, 空闲秒, 分类] 逐次推进。 */
function run(steps, store = createAccountingStore(), extra = {}) {
  const events = [];
  for (const [minute, idleSec, category = "unaccounted"] of steps) {
    const result = advanceAccounting(store, { nowMs:at(minute), dayKey:DAY, dailyPath:PATH, idleSec, category, settings, ...extra });
    store = result.store;
    events.push(...result.events);
  }
  return { store, events };
}

/** 每 5 秒一次在场轮询，从 from 到 to 分钟。 */
function presentSteps(from, to, category = "unaccounted") {
  const steps = [];
  for (let minute = from; minute <= to + 1e-9; minute += 5 / 60) steps.push([minute, 1, category]);
  return steps;
}

const lines = store => store.outbox.filter(entry => entry.kind === "line").map(entry => entry.text);
const summary = store => store.outbox.filter(entry => entry.kind === "summary").at(-1)?.values;

test("运行态分类：只有空闲、暂停、等待确认算未归属", () => {
  assert.deepEqual(classifyRuntime({ status:"idle", attention:null }), { category:"unaccounted", reason:"idle" });
  assert.deepEqual(classifyRuntime({ status:"paused", attention:null }), { category:"unaccounted", reason:"paused" });
  assert.deepEqual(classifyRuntime({ status:"awaiting", attention:{ type:"break" } }), { category:"unaccounted", reason:"awaiting" });
  assert.deepEqual(classifyRuntime({ status:"running", moduleRun:{ type:"work" } }), { category:"work", reason:null });
  assert.deepEqual(classifyRuntime({ status:"running", moduleRun:{ type:"rest" }, attention:{ nextStarted:true } }), { category:"rest", reason:null });
  assert.equal(classifyRuntime({ status:"settling" }).category, "busy");
  assert.equal(classifyRuntime({ status:"idle", pendingSettlement:{ id:"x" } }).category, "busy");
});

test("连续在场的未归属时间累计，开始工作时写一行未归属记录", () => {
  const { store } = run([...presentSteps(0, 12), [12.05, 1, "work"]]);
  assert.equal(store.stretch, null);
  assert.equal(Math.round(store.unaccountedMs / MIN), 12);
  assert.deepEqual(lines(store), [`${clockText(at(0))}–${clockText(at(12.05))} 未归属 12 分钟`]);
  assert.equal(summary(store)["未归属分钟"], 12);
});

test("离开时扣回无输入的尾巴，不满 1 分钟的未归属不写日记", () => {
  // 在场 6 分钟后停手，90 秒内仍算在场，到 120 秒判定离开。
  const steps = presentSteps(0, 6);
  for (let s = 5; s <= 125; s += 5) steps.push([6 + s / 60, s]);
  const { store } = run(steps);
  assert.equal(store.stretch, null);
  assert.equal(Math.round(store.unaccountedMs / 1000), 360);
  assert.deepEqual(lines(store), [`${clockText(at(0))}–${clockText(at(6))} 未归属 6 分钟`]);
  const short = run([...presentSteps(0, 0.5), [0.6, 1, "work"]]).store;
  assert.deepEqual(lines(short), []);
});

test("插件关闭或睡眠造成的空档在最后一次在场时结束上一段", () => {
  const first = run(presentSteps(0, 3)).store;
  const { store } = run([[120, 1]], first);
  assert.ok(store.stretch);
  assert.equal(store.stretch.startedAtMs, at(120));
  assert.deepEqual(lines(store), [`${clockText(at(0))}–${clockText(at(3))} 未归属 3 分钟`]);
  assert.equal(Math.round(store.unaccountedMs / MIN), 3);
});

test("跨天时写入前一天汇总并清零", () => {
  let { store } = run([...presentSteps(0, 2), [2, 1, "work"]]);
  store = snoozeAccounting(store, at(2), settings).store;
  const next = advanceAccounting(store, { nowMs:at(24 * 60), dayKey:"2026-10-15", dailyPath:"Daily/2026-10-15.md", idleSec:1, category:"work", settings }).store;
  assert.equal(next.dayKey, "2026-10-15");
  assert.equal(next.unaccountedMs, 0);
  assert.equal(next.snoozeCount, 0);
  const old = next.outbox.filter(entry => entry.kind === "summary" && entry.path === PATH).at(-1);
  assert.deepEqual(old.values, { "未归属分钟":2, "消遣分钟":0, "稍后提醒次数":1 });
});

test("声明不计时必须写理由、类型和时长", () => {
  const store = run([[0, 1]]).store;
  const nowMs = at(1);
  assert.equal(declareUntracked(store, { kind:"leisure", reason:"  ", minutes:30, nowMs }, settings).ok, false);
  assert.equal(declareUntracked(store, { kind:"other", reason:"x", minutes:30, nowMs }, settings).ok, false);
  assert.equal(declareUntracked(store, { kind:"errand", reason:"开会", minutes:0, nowMs }, settings).ok, false);
  assert.equal(declareUntracked(store, { kind:"errand", reason:"开会", minutes:999, nowMs }, settings).ok, false);
  const ok = declareUntracked(store, { kind:"errand", reason:"开会", minutes:45, nowMs }, settings);
  assert.equal(ok.ok, true);
  assert.equal(declareUntracked(ok.store, { kind:"errand", reason:"再来", minutes:5, nowMs }, settings).ok, false);
});

test("消遣到期后按计划时长记账并发出结束事件，声明期间不算未归属", () => {
  const base = run(presentSteps(0, 2)).store;
  const declared = declareUntracked(base, { kind:"leisure", reason:"刷 X", minutes:20, nowMs:at(2) }, settings);
  assert.equal(declared.ok, true);
  assert.equal(declared.overBudgetMin, 0);
  // 声明期间人在电脑前，也不计入未归属。
  const during = run(presentSteps(2.1, 21.9), declared.store);
  assert.equal(during.store.stretch, null);
  assert.equal(Math.round(during.store.unaccountedMs / MIN), 2);
  const { store, events } = run([[40, 1]], during.store);
  assert.equal(events.length, 1);
  assert.equal(events[0].expired, true);
  assert.equal(events[0].actualMs, 20 * MIN);
  assert.equal(store.leisureMs, 20 * MIN);
  assert.ok(lines(store).includes(`${clockText(at(2))}–${clockText(at(22))} 消遣 20 分钟：刷 X`));
  // 到期后立刻回到未归属。
  assert.equal(store.stretch.startedAtMs, at(40));
});

test("开始工作会提前结束声明；超出消遣额度时标记，事务不占额度", () => {
  let store = run([[0, 1]]).store;
  store = declareUntracked(store, { kind:"leisure", reason:"刷 X", minutes:25, nowMs:at(0) }, settings).store;
  store = run([[25, 1, "work"]], store).store;
  const second = declareUntracked(store, { kind:"leisure", reason:"看视频", minutes:15, nowMs:at(30) }, settings);
  assert.equal(second.overBudgetMin, 10);
  const ended = run([[42, 1, "work"]], second.store);
  assert.equal(ended.events[0].expired, false);
  assert.equal(ended.store.leisureMs, 37 * MIN);
  assert.ok(lines(ended.store).includes(`${clockText(at(30))}–${clockText(at(42))} 消遣 12 分钟：看视频（超出额度 7 分钟）`));
  let errand = declareUntracked(ended.store, { kind:"errand", reason:"开会", minutes:60, nowMs:at(50) }, settings).store;
  errand = endDeclaration(errand, at(80), settings).store;
  assert.equal(errand.leisureMs, 37 * MIN);
  assert.ok(lines(errand).includes(`${clockText(at(50))}–${clockText(at(80))} 事务 30 分钟：开会`));
  assert.equal(summary(errand)["消遣分钟"], 37);
});

test("稍后提醒每天限次并写日记；静音期间仍计入未归属", () => {
  let store = run([[0, 1]]).store;
  for (let i = 1; i <= 3; i += 1) {
    const result = snoozeAccounting(store, at(i), settings);
    assert.equal(result.ok, true);
    store = result.store;
  }
  assert.equal(snoozeAccounting(store, at(4), settings).ok, false);
  assert.ok(lines(store).includes(`${clockText(at(3))} 稍后提醒（今日第 3 次）`));
  store = run(presentSteps(0, 6), store).store;
  assert.ok(store.unaccountedMs >= 5.9 * MIN);
});

/** 用阶梯走一遍，返回 [分钟, 动作]（只保留非 none）。 */
function ladderRun(steps, { stretchStart = at(0), reason = "idle", snoozeUntilMs = 0, promptOpen = false, overlayVisible = false, overlayDismissedAtMs = null, ladderSettings = settings } = {}) {
  let state = createLadderState();
  const actions = [];
  for (const [minute, idleSec = 10] of steps) {
    const result = evaluateLadder(state, { nowMs:at(minute), stretch:{ startedAtMs:stretchStart, lastPresentAtMs:at(minute), countedMs:0 },
      reason, idleSec, snoozeUntilMs, promptOpen, overlayVisible, overlayDismissedAtMs, settings:ladderSettings });
    state = result.state;
    if (result.action !== "none") actions.push([minute, result.action]);
  }
  return actions;
}

test("提醒阶梯：1 分钟通知、5 分钟弹窗、每 5 分钟重复", () => {
  assert.deepEqual(ladderRun([[0.5], [1], [2], [5], [7], [10]]), [[1, "notify"], [5, "prompt"], [10, "prompt"]]);
  assert.deepEqual(ladderRun([[1], [5]], { reason:"awaiting" }), [[5, "prompt"]]);
  assert.deepEqual(ladderRun([[1], [5]], { promptOpen:true }), []);
});

test("弹窗前等用户停手，最多等 30 秒", () => {
  assert.deepEqual(ladderRun([[5, 0.5], [5 + 1 / 60, 0.3], [5 + 2 / 60, 3]]), [[5, "wait"], [5 + 1 / 60, "wait"], [5 + 2 / 60, "prompt"]]);
  const typing = [];
  for (let s = 0; s <= 35; s += 5) typing.push([5 + s / 60, 0.2]);
  const actions = ladderRun(typing);
  assert.equal(actions.at(-1)[1], "prompt");
  assert.ok(actions.filter(([, action]) => action === "wait").length >= 6);
});

test("稍后提醒期间阶梯静默，结束后立即弹窗", () => {
  assert.deepEqual(ladderRun([[1], [5], [12], [15]], { snoozeUntilMs:at(15) }), [[15, "prompt"]]);
});

test("存储与设置规范化", () => {
  assert.deepEqual(normalizeAccountingStore({ schemaVersion:99 }), createAccountingStore());
  const declared = declareUntracked({ ...createAccountingStore(), dayKey:DAY, dailyPath:PATH }, { kind:"leisure", reason:"刷 X", minutes:10, nowMs:T0 }, settings).store;
  const roundTrip = normalizeAccountingStore(JSON.parse(JSON.stringify(declared)));
  assert.deepEqual(roundTrip, declared);
  const normalized = normalizeCurrentSettings({ accountingNotifyAfterMin:"x", accountingSnoozeLimit:0, accountingLeisureBudgetMin:-3, accountingAwaySec:2, accountingHeading:"## 归属" });
  assert.equal(normalized.accountingNotifyAfterMin, 1);
  assert.equal(normalized.accountingSnoozeLimit, 0);
  assert.equal(normalized.accountingLeisureBudgetMin, 30);
  assert.equal(normalized.accountingAwaySec, 10);
  assert.equal(normalized.accountingHeading, "归属");
  assert.deepEqual(normalizeAccountingSettings({}), { ...ACCOUNTING_DEFAULTS });
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

function accountingPlugin(vault = new FakeVault()) {
  const plugin = createPlugin({ vault, todayPath:PATH, settings:{
    modules:[
      { id:"work-1", type:"work", name:"工作", durationMin:25, blackout:false },
      { id:"rest-1", type:"rest", name:"散步", durationMin:5, blackout:false }
    ],
    projectAssignments:{}, loopMode:"once", loopCount:1, autoAdvance:false,
    enableProjects:false, enableNotify:true, enableSound:true, allowCreateDaily:true, ...ACCOUNTING_DEFAULTS
  } });
  plugin.runtime.status = "idle";
  plugin.runtime.attention = null;
  plugin.logicalTodayKey = () => DAY;
  return plugin;
}

function controllerFor(plugin, clock, idle = () => 5) {
  const events = [];
  const stored = { value:null };
  plugin.app.loadLocalStorage = () => stored.value;
  plugin.app.saveLocalStorage = (key, value) => { stored.value = value; };
  const controller = new TimeAccountingController(plugin, {
    monitor:{ readIdleSeconds:async () => idle(), activateObsidian:async () => { events.push("activate"); }, dispose() {} },
    timers:{ setInterval:() => 1, clearInterval() {}, setTimeout:() => 2, clearTimeout() {} },
    playBeep:(kind, enabled, waveform, strong) => events.push(strong ? "beep-strong" : "beep"),
    sysNotify:title => events.push(`notify:${title}`),
    logPluginError:(operation, error) => { throw error; },
    now:() => clock.value
  });
  return { controller, events, stored };
}

async function pollUntil(controller, clock, toMinute) {
  while (clock.value < at(toMinute)) {
    clock.value += 5000;
    await controller.poll();
  }
}

test("控制器：通知、等停手后弹窗，声明后写入日记标题与汇总", async () => {
  const vault = new FakeVault();
  const plugin = accountingPlugin(vault);
  const prompts = [];
  plugin.openAccountingPrompt = reason => prompts.push(reason);
  const clock = { value:at(0) };
  const { controller, events, stored } = controllerFor(plugin, clock);
  controller._loaded = controller.load();
  await controller.poll();
  await pollUntil(controller, clock, 5);
  assert.deepEqual(events, ["notify:这段时间还没有归属", "beep", "beep-strong", "activate"]);
  assert.deepEqual(prompts, ["idle"]);

  assert.equal(controller.declare({ kind:"leisure", reason:"刷 X", minutes:10 }), true);
  await pollUntil(controller, clock, 16);
  await controller.flush();
  const text = vault.getAbstractFileByPath(PATH).content;
  assert.match(text, /## 时间归属/);
  assert.ok(text.includes(`- ${clockText(at(0))}–${clockText(at(5))} 未归属 5 分钟`));
  assert.ok(text.includes(`- ${clockText(at(5))}–${clockText(at(15))} 消遣 10 分钟：刷 X`));
  assert.ok(events.includes("notify:不计时已结束"));
  assert.deepEqual(stored.value.outbox, []);
  assert.equal(controller.view().leisureUsedMin, 10);
});

test("控制器：日记写入失败时保留队列并在下次重试", async () => {
  const vault = new FakeVault();
  const plugin = accountingPlugin(vault);
  plugin.openAccountingPrompt = () => {};
  const clock = { value:at(0) };
  const { controller } = controllerFor(plugin, clock);
  const errors = [];
  controller.helpers.logPluginError = (operation, error) => errors.push(String(error));
  controller._loaded = controller.load();
  await pollUntil(controller, clock, 2);
  controller.snooze();
  const original = vault.process.bind(vault);
  vault.process = async () => { throw new Error("disk full"); };
  await controller.flush();
  assert.ok(controller.store.outbox.length > 0);
  vault.process = original;
  await controller.flush();
  assert.deepEqual(errors.slice(1), []);
  assert.equal(controller.store.outbox.length, 0);
  assert.ok(vault.getAbstractFileByPath(PATH).content.includes("稍后提醒（今日第 1 次）"));
});

test("从选择弹窗开始工作或休息：写入事情名称、结束声明、从对应模块开始", async () => {
  const plugin = accountingPlugin();
  const started = [];
  plugin.startSequence = async index => { started.push(index); return true; };
  const ended = [];
  plugin.accounting = { endDeclaration:() => ended.push(true), view:() => ({}) };
  assert.equal(await plugin.startWorkFromPrompt("work-1", "  写周报 "), true);
  assert.equal(plugin.settings.modules[0].name, "写周报");
  assert.equal(await plugin.startRestFromPrompt("rest-1"), true);
  assert.deepEqual(started, [0, 1]);
  assert.equal(ended.length, 2);
  assert.equal(await plugin.startWorkFromPrompt("rest-1", "x"), false);
  plugin.runtime.status = "running";
  assert.equal(await plugin.startRestFromPrompt("rest-1"), false);
  assert.deepEqual(started, [0, 1]);
});

const strict = { ...ACCOUNTING_DEFAULTS, accountingMode:"strict" };

test("强制模式：10 分钟盖上全屏遮罩；遮罩或弹窗打开时不再升级；关掉 60 秒后重新盖上", () => {
  assert.deepEqual(ladderRun([[1], [5], [10]], { ladderSettings:strict }), [[1, "notify"], [5, "prompt"], [10, "overlay"]]);
  assert.deepEqual(ladderRun([[1], [5], [10]]), [[1, "notify"], [5, "prompt"], [10, "prompt"]]);
  assert.deepEqual(ladderRun([[10], [11]], { ladderSettings:strict, overlayVisible:true }), []);
  assert.deepEqual(ladderRun([[11], [11.5], [12]], { ladderSettings:strict, overlayDismissedAtMs:at(11) }), [[11, "prompt"], [12, "overlay"]]);
  assert.deepEqual(ladderRun([[10, 0.5], [10.6, 3]], { ladderSettings:strict }), [[10, "wait"], [10.6, "overlay"]]);
});

test("强制模式：消遣不能超出额度，按剩余截断，用完后拒绝", () => {
  let store = { ...createAccountingStore(), dayKey:DAY, dailyPath:PATH, leisureMs:22 * MIN };
  const capped = declareUntracked(store, { kind:"leisure", reason:"刷 X", minutes:30, nowMs:at(0) }, strict);
  assert.equal(capped.ok, true);
  assert.equal(capped.cappedMin, 8);
  assert.equal(capped.store.declaration.plannedMs, 8 * MIN);
  store = endDeclaration(capped.store, at(30), strict).store;
  assert.equal(store.leisureMs, 30 * MIN);
  const refused = declareUntracked(store, { kind:"leisure", reason:"再刷", minutes:5, nowMs:at(31) }, strict);
  assert.deepEqual(refused, { ok:false, error:"今日消遣额度已用完（强制模式）" });
  assert.equal(declareUntracked(store, { kind:"errand", reason:"开会", minutes:30, nowMs:at(31) }, strict).ok, true);
  assert.equal(declareUntracked(store, { kind:"leisure", reason:"再刷", minutes:5, nowMs:at(31) }, settings).ok, true);
});

test("强制模式：放宽设置推迟到次日，收紧立即生效并撤掉同项的推迟", () => {
  const current = { ...strict };
  const loosen = splitAccountingPatch(current, { accountingLeisureBudgetMin:60, accountingPromptAfterMin:3 }, DAY);
  assert.deepEqual(loosen.deferredKeys, ["accountingLeisureBudgetMin"]);
  assert.equal(loosen.immediate.accountingPromptAfterMin, 3);
  assert.equal("accountingLeisureBudgetMin" in loosen.immediate, false);
  assert.deepEqual(loosen.pending, { requestedDayKey:DAY, patch:{ accountingLeisureBudgetMin:60 } });
  const withPending = { ...current, accountingPending:loosen.pending };
  const off = splitAccountingPatch(withPending, { accountingMode:"remind", accountingEnabled:false }, DAY);
  assert.deepEqual(off.pending.patch, { accountingLeisureBudgetMin:60, accountingEnabled:false, accountingMode:"remind" });
  const tighten = splitAccountingPatch({ ...withPending }, { accountingLeisureBudgetMin:20 }, DAY);
  assert.equal(tighten.immediate.accountingLeisureBudgetMin, 20);
  assert.equal(tighten.pending, null);
  const remind = splitAccountingPatch({ ...ACCOUNTING_DEFAULTS }, { accountingLeisureBudgetMin:90, accountingMode:"strict" }, DAY);
  assert.deepEqual(remind.deferredKeys, []);
  assert.equal(remind.immediate.accountingMode, "strict");
  assert.equal(duePendingPatch({ ...withPending }, DAY), null);
  assert.deepEqual(duePendingPatch({ ...withPending }, "2026-10-15"), { accountingLeisureBudgetMin:60 });
});

test("插件跨天后应用待生效的放宽设置", async () => {
  const plugin = accountingPlugin();
  Object.assign(plugin.settings, { accountingMode:"strict", accountingPending:{ requestedDayKey:"2026-10-13", patch:{ accountingMode:"remind", accountingLeisureBudgetMin:60 } } });
  assert.equal(await plugin.applyDueAccountingSettings(), true);
  assert.equal(plugin.settings.accountingMode, "remind");
  assert.equal(plugin.settings.accountingLeisureBudgetMin, 60);
  assert.equal(plugin.settings.accountingPending, null);
  assert.equal(await plugin.applyDueAccountingSettings(), false);
});

function fakeChild() {
  const child = new EventEmitter();
  child.written = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { writable:true, write:line => { child.written.push(JSON.parse(line)); return true; }, end() {} });
  child.exitCode = null;
  child.kill = () => {};
  return child;
}

test("原生遮罩：以提示模式显示，点“去选择”后关闭并回调", () => {
  const child = fakeChild();
  let chosen = 0;
  const overlay = new AccountingOverlay({ document:null, binaryPath:"/bin/helper", spawnProcess:() => child, onChoose:() => { chosen += 1; } });
  overlay.show({ label:"已经有 10 分钟没有归属", title:"现在要做什么？" });
  assert.equal(overlay.visible, true);
  assert.deepEqual(child.written[0], { type:"show", mode:"prompt", buttonTitle:"去选择", label:"已经有 10 分钟没有归属", title:"现在要做什么？" });
  overlay.show({ label:"11", title:"现在要做什么？" });
  assert.equal(child.written[1].type, "update");
  child.stdout.emit("data", '{"type":"dismissed"}\n');
  assert.equal(chosen, 1);
  assert.equal(overlay.visible, false);
  child.emit("exit", 0);
  assert.equal(chosen, 1);
});

function fakeDomDocument() {
  const make = () => {
    const el = { children:[], className:"", textContent:"", attributes:{}, onclick:null,
      setAttribute(k, v) { this.attributes[k] = v; },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      append(...items) { items.forEach(item => this.appendChild(item)); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); },
      querySelectorAll(selector) {
        const names = selector.split(",").map(item => item.trim().slice(1));
        const out = [];
        const walk = node => node.children.forEach(child => { if (names.some(name => child.className.split(" ").includes(name))) out.push(child); walk(child); });
        walk(this);
        return out;
      } };
    return el;
  };
  const body = make();
  return { body, createElement:make };
}

test("原生助手不可用时退回 Obsidian 窗口遮罩", () => {
  const document = fakeDomDocument();
  const reasons = [];
  let chosen = 0;
  const overlay = new AccountingOverlay({ document, binaryPath:"/bin/helper",
    spawnProcess:() => { throw new Error("ENOENT"); }, onChoose:() => { chosen += 1; }, onUnavailable:reason => reasons.push(reason) });
  overlay.show({ label:"已经有 10 分钟没有归属", title:"现在要做什么？" });
  assert.equal(reasons.length, 1);
  assert.equal(document.body.children.length, 1);
  const button = document.body.children[0].children[0].children.find(child => child.textContent === "去选择");
  button.onclick({ stopPropagation() {} });
  assert.equal(chosen, 1);
  assert.equal(document.body.children.length, 0);
});

test("控制器（强制模式）：盖上遮罩，选择后打开弹窗，开始工作后撤下", async () => {
  const plugin = accountingPlugin();
  Object.assign(plugin.settings, strict);
  const prompts = [];
  plugin.openAccountingPrompt = reason => prompts.push(reason);
  const clock = { value:at(0) };
  const shown = [];
  let visible = false;
  const { controller, events } = controllerFor(plugin, clock);
  controller.overlay = { get visible() { return visible; }, show:message => { visible = true; shown.push(message); }, hide:() => { visible = false; }, destroy() {} };
  // 用真实回调路径模拟遮罩按钮。
  const choose = () => { visible = false; return controller._overlayChosen(); };
  controller._loaded = controller.load();
  await pollUntil(controller, clock, 10);
  assert.equal(prompts.length, 1);
  controller.setPromptOpen(false);
  await pollUntil(controller, clock, 10.1);
  assert.equal(visible, true);
  assert.match(shown[0].label, /10 分钟/);
  await choose();
  assert.deepEqual(prompts, ["idle", "idle"]);
  assert.ok(events.includes("activate"));
  plugin.runtime.status = "running";
  plugin.runtime.moduleRun = { type:"work" };
  visible = true;
  await pollUntil(controller, clock, 10.3);
  assert.equal(visible, false);
});
