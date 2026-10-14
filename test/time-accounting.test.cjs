const test = require("node:test");
const assert = require("node:assert/strict");
// support 先用假 obsidian 加载插件，后面 require 的模块复用同一缓存。
const { createPlugin, FakeVault } = require("./support.cjs");
const {
  ACCOUNTING_DEFAULTS,
  normalizeAccountingSettings,
  splitAccountingPatch,
  duePendingPatch,
  extendDeclaration,
  declarationRemainingMs,
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
const { AccountingScreen } = require("../src/ui/accounting-screen.js");
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
function ladderRun(steps, { stretchStart = at(0), reason = "idle", snoozeUntilMs = 0, promptOpen = false, ladderSettings = settings } = {}) {
  let state = createLadderState();
  const actions = [];
  for (const [minute, idleSec = 10] of steps) {
    const result = evaluateLadder(state, { nowMs:at(minute), stretch:{ startedAtMs:stretchStart, lastPresentAtMs:at(minute), countedMs:0 },
      reason, idleSec, snoozeUntilMs, promptOpen, settings:ladderSettings });
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
  assert.deepEqual(events, ["notify:这段时间还没有归属", "beep", "beep-strong"]);
  assert.deepEqual(prompts, ["idle"]);

  assert.deepEqual(controller.declare({ kind:"leisure", reason:"刷 X", minutes:10 }), { ok:true });
  await pollUntil(controller, clock, 16);
  await controller.flush();
  const text = vault.getAbstractFileByPath(PATH).content;
  assert.match(text, /## 时间归属/);
  assert.ok(text.includes(`- ${clockText(at(0))}–${clockText(at(5))} 未归属 5 分钟`));
  assert.ok(text.includes(`- ${clockText(at(5))}–${clockText(at(15))} 消遣 10 分钟：刷 X`));
  // 小计时到点直接弹出黑屏，不再发通知。
  assert.deepEqual(prompts, ["idle", "idle"]);
  assert.ok(!events.some(event => event.startsWith("notify:不计时")));
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

test("强制模式与提醒模式阶梯一致：5 分钟黑屏选择，不再有第二级遮罩", () => {
  assert.deepEqual(ladderRun([[1], [5], [10]], { ladderSettings:strict }), [[1, "notify"], [5, "prompt"], [10, "prompt"]]);
  assert.deepEqual(ladderRun([[5], [10], [15]], { ladderSettings:strict, promptOpen:true }), []);
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

const tick = () => new Promise(resolve => { setImmediate(resolve); });

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

const screenData = {
  reason:"idle", label:"已经有 5 分钟没有归属 · 今日累计 12 分钟", title:"现在要做什么？", closable:false, initialTab:"work", display:"main",
  workModules:[{ id:"work-1", name:"写周报", durationMin:25, workspaceCommandId:"ws-write", lightProgramId:"", blackout:false }],
  restModules:[{ id:"rest-1", name:"散步", durationMin:5, workspaceCommandId:"", lightProgramId:"rest", blackout:true }],
  defaultWorkId:"work-1", defaultRestId:"rest-1", candidates:[],
  restPresets:["NSDR 非睡眠深度休息", "散步", "喝水"],
  workspaceCommands:[{ id:"ws-write", title:"写作" }, { id:"ws-read", title:"阅读" }],
  lightPrograms:[{ id:"work", title:"专注" }, { id:"rest", title:"放松" }],
  againText:"", leisureLeftMin:30, strictBudget:true, snoozesLeft:3, snoozeMin:10, currentName:"当前模块"
};

test("原生选择屏：发送界面数据；选择成功后撤下，失败时把错误发回界面", async () => {
  const child = fakeChild();
  const choices = [];
  const closed = [];
  let result = { ok:false, error:"今日消遣额度已用完（强制模式）" };
  const screen = new AccountingScreen({ document:null, binaryPath:"/bin/accounting", spawnProcess:() => child,
    onChoice:async choice => { choices.push(choice); return result; }, onClosed:reason => closed.push(reason) });
  screen.show(screenData);
  assert.equal(screen.visible, true);
  assert.deepEqual(child.written[0], { type:"show", ...screenData });
  screen.update({ candidates:["写周报", "回邮件"] });
  assert.deepEqual(child.written[1], { type:"update", candidates:["写周报", "回邮件"] });

  child.stdout.emit("data", '{"type":"choice","action":"declare","kind":"leisure","reason":"刷 X","minutes":10}\n');
  await tick();
  assert.equal(choices[0].reason, "刷 X");
  assert.deepEqual(child.written.at(-1), { type:"error", message:"今日消遣额度已用完（强制模式）" });
  assert.equal(screen.visible, true);

  result = { ok:true };
  child.stdout.emit("data", '{"type":"choice","action":"work","moduleId":"work-1","name":"写周报"}\n');
  await tick();
  assert.deepEqual(child.written.at(-1), { type:"hide" });
  assert.equal(screen.visible, false);
  assert.deepEqual(closed, ["chosen"]);
  child.emit("exit", 0);
  assert.deepEqual(closed, ["chosen"]);
});

test("原生选择屏：关闭与紧急退出只回报，不当作选择；被外部结束按关闭处理", async () => {
  for (const action of ["close", "emergency"]) {
    const child = fakeChild();
    const closed = [];
    let chose = false;
    const screen = new AccountingScreen({ document:null, binaryPath:"/bin/accounting", spawnProcess:() => child,
      onChoice:async () => { chose = true; return { ok:true }; }, onClosed:reason => closed.push(reason) });
    screen.show(screenData);
    child.stdout.emit("data", `{"type":"choice","action":"${action}"}\n`);
    await tick();
    assert.equal(chose, false);
    assert.deepEqual(closed, [action]);
    assert.equal(screen.visible, false);
  }
  const child = fakeChild();
  const closed = [];
  const screen = new AccountingScreen({ document:null, binaryPath:"/bin/accounting", spawnProcess:() => child,
    onChoice:async () => ({ ok:true }), onClosed:reason => closed.push(reason) });
  screen.show(screenData);
  child.emit("exit", 9);
  assert.deepEqual(closed, ["exited"]);
  assert.equal(screen.visible, false);
});

/** 只实现选择屏用到的 DOM 接口。 */
function fakeDom() {
  const listeners = {};
  const make = tag => {
    const el = {
      tagName:tag.toUpperCase(), children:[], className:"", textContent:"", attributes:{}, style:{}, value:"",
      parent:null, disabled:false, focused:false,
      classList:{
        toggle(name, on) { const set = new Set(el.className.split(" ").filter(Boolean)); (on ?? !set.has(name)) ? set.add(name) : set.delete(name); el.className = [...set].join(" "); },
        add(name) { el.classList.toggle(name, true); }, remove(name) { el.classList.toggle(name, false); },
        contains(name) { return el.className.split(" ").includes(name); }
      },
      setAttribute(k, v) { el.attributes[k] = v; },
      appendChild(child) { child.parent = el; el.children.push(child); return child; },
      append(...items) { items.forEach(item => el.appendChild(item)); },
      replaceChildren() { el.children = []; },
      remove() { if (el.parent) el.parent.children = el.parent.children.filter(child => child !== el); },
      focus() { el.focused = true; }
    };
    return el;
  };
  const body = make("body");
  return {
    body, listeners, createElement:make,
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type) { delete listeners[type]; }
  };
}

function hiddenUp(node) {
  for (let current = node; current; current = current.parent) if (current.hidden) return true;
  return false;
}

function findAll(node, predicate, out = []) {
  for (const child of node.children) {
    if (predicate(child)) out.push(child);
    findAll(child, predicate, out);
  }
  return out;
}

test("原生程序不可用时在 Obsidian 窗口内显示黑色选择屏：数字键切换、长按 Esc 紧急退出", async () => {
  const document = fakeDom();
  const unavailable = [];
  const closed = [];
  let now = 0;
  const frames = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  let activated = 0;
  const screen = new AccountingScreen({ document, binaryPath:"/bin/accounting",
    spawnProcess:() => { throw new Error("ENOENT"); }, onUnavailable:reason => unavailable.push(reason),
    onChoice:async () => ({ ok:true }), onClosed:reason => closed.push(reason),
    activateObsidian:async () => { activated += 1; }, now:() => now });
  screen.show(screenData);
  assert.equal(unavailable.length, 1);
  assert.equal(activated, 1);
  const root = document.body.children[0];
  assert.equal(root.className, "pmd-accounting-screen");
  assert.ok(findAll(root, el => el.textContent === "现在要做什么？").length);
  assert.ok(findAll(root, el => el.textContent === "长按 esc 3 秒紧急退出").length);
  assert.ok(findAll(root, el => el.className.includes("pmd-as-input") && el.value === "写周报").length);

  const key = (type, key, extra = {}) => document.listeners[type]({ key, repeat:false, isComposing:false, target:root,
    preventDefault() {}, stopPropagation() {}, ...extra });
  key("keydown", "3");
  assert.ok(findAll(root, el => el.textContent === "开始小计时  ↵" && !hiddenUp(el)).length);
  key("keydown", "2");
  // 休息页列出全部休息预设，模块当前名称对应的预设已选中。
  const presets = findAll(root, el => el.className.includes("is-preset"));
  assert.deepEqual(presets.map(el => el.textContent), ["NSDR 非睡眠深度休息", "散步", "喝水"]);
  assert.ok(presets[1].className.includes("is-selected"));

  // 按住 1 秒松开不会退出；按满 3 秒才紧急退出。
  key("keydown", "Escape");
  now = 1000;
  frames.shift()();
  key("keyup", "Escape");
  assert.deepEqual(closed, []);
  key("keydown", "Escape");
  now = 4100;
  while (frames.length) frames.shift()();
  await tick();
  assert.deepEqual(closed, ["emergency"]);
  assert.equal(document.body.children.length, 0);
  assert.equal(screen.visible, false);
});

test("提醒模式的窗口内选择屏：按一下 Esc 就关闭", async () => {
  const document = fakeDom();
  const closed = [];
  const screen = new AccountingScreen({ document, binaryPath:null, onChoice:async () => ({ ok:true }), onClosed:reason => closed.push(reason) });
  screen.show({ ...screenData, closable:true });
  document.listeners.keydown({ key:"Escape", repeat:false, isComposing:false, preventDefault() {}, stopPropagation() {} });
  await tick();
  assert.deepEqual(closed, ["close"]);
  assert.equal(screen.visible, false);
});

test("控制器：关闭后从关闭时刻起算间隔；紧急退出写一行日记", async () => {
  const vault = new FakeVault();
  const plugin = accountingPlugin(vault);
  Object.assign(plugin.settings, strict);
  const clock = { value:at(0) };
  const { controller } = controllerFor(plugin, clock);
  let prompts = 0;
  plugin.openAccountingPrompt = () => { prompts += 1; controller.setPromptOpen(true); };
  controller._loaded = controller.load();
  await pollUntil(controller, clock, 8);
  assert.equal(prompts, 1);
  // 选择屏开着时不重复弹出。
  controller.setPromptOpen(false);
  controller.emergencyExit();
  await pollUntil(controller, clock, 12.9);
  assert.equal(prompts, 1);
  await pollUntil(controller, clock, 13.1);
  assert.equal(prompts, 2);
  await controller.flush();
  assert.ok(vault.getAbstractFileByPath(PATH).content.includes(`- ${clockText(at(8))} 紧急退出归属选择`));
});

test("插件：选择屏数据（强制模式不可直接关闭，手动打开可关闭）与选择分派", async () => {
  const plugin = accountingPlugin();
  Object.assign(plugin.settings, strict, { accountingDisplay:"E9648175-DE3C-457B-94BC-1F3B2A5B559B",
    restPresets:["NSDR 非睡眠深度休息", "在窗边看远方", "散步", "闭眼休息", "喝水", "拉伸"] });
  plugin.getWorkspaceLayoutCommands = () => [{ id:"ws-write", name:"Workspaces Plus: Load 写作" }];
  plugin.accounting = { view:() => ({ strict:true, stretchMin:7, unaccountedMin:12, leisureBudgetMin:30, leisureUsedMin:10, snoozesLeft:2 }),
    declare:input => ({ ok:input.reason === "开会" || input.minutes === 5 }), snooze:() => ({ ok:true }), endDeclaration() {} };
  const data = plugin.accountingScreenData("idle");
  assert.equal(data.closable, false);
  assert.equal(plugin.accountingScreenData("idle", { manual:true }).closable, true);
  assert.equal(data.label, "已经有 7 分钟没有归属 · 今日累计 12 分钟");
  assert.equal(data.leisureLeftMin, 20);
  assert.equal(data.display, "E9648175-DE3C-457B-94BC-1F3B2A5B559B");
  assert.deepEqual(data.workModules[0], { id:"work-1", name:"工作", durationMin:25, workspaceCommandId:"", lightProgramId:"", blackout:false });
  assert.deepEqual(data.restModules.map(module => module.id), ["rest-1"]);
  assert.equal(data.restPresets.length, 6);
  assert.equal(data.workspaceCommands[0].id, "ws-write");
  assert.equal(data.againText, "");

  const started = [];
  plugin.startSequence = async index => { started.push(index); return true; };
  // 工作：名称、时长、布局、灯光、黑屏一起写回模块设置，再从该模块开始。
  assert.deepEqual(await plugin.handleAccountingChoice({ action:"work", moduleId:"work-1", name:"写周报", durationMin:45,
    workspaceCommandId:"ws-write", lightProgramId:"none", blackout:true }), { ok:true });
  assert.deepEqual(plugin.settings.modules[0], { id:"work-1", type:"work", name:"写周报", durationMin:45, blackout:true,
    workspaceCommandId:"ws-write", lightProgramId:"none" });
  // 未知布局不写入。
  await plugin.handleAccountingChoice({ action:"work", moduleId:"work-1", name:"写周报", workspaceCommandId:"ws-unknown" });
  assert.equal(plugin.settings.modules[0].workspaceCommandId, "ws-write");
  // 休息：预设名称和时长写回休息模块。
  assert.deepEqual(await plugin.handleAccountingChoice({ action:"rest", moduleId:"rest-1", name:"喝水", durationMin:3, lightProgramId:"", blackout:false }), { ok:true });
  assert.equal(plugin.settings.modules[1].name, "喝水");
  assert.equal(plugin.settings.modules[1].durationMin, 3);
  assert.deepEqual(started, [0, 0, 1]);
  assert.deepEqual(await plugin.handleAccountingChoice({ action:"declare", kind:"errand", reason:"开会", minutes:30 }), { ok:true });
  assert.deepEqual(await plugin.handleAccountingChoice({ action:"again" }), { ok:false, error:"没有可以继续的小计时" });
  const ended = plugin.accountingScreenData("idle", { ended:{ kind:"leisure", reason:"刷 X", plannedMs:15 * MIN } });
  assert.equal(ended.againText, "再来 5 分钟：消遣 · 刷 X");
  assert.match(ended.label, /^「刷 X」的 15 分钟消遣已结束/);
  assert.deepEqual(await plugin.handleAccountingChoice({ action:"again" }), { ok:true });
  assert.deepEqual(await plugin.handleAccountingChoice({ action:"bogus" }), { ok:false, error:"未知操作" });
});

test("小计时延长：提醒模式照常延长，强制模式按剩余额度截断，已结束不能延长", () => {
  let store = { ...createAccountingStore(), dayKey:DAY, dailyPath:PATH, leisureMs:10 * MIN };
  store = declareUntracked(store, { kind:"leisure", reason:"刷 X", minutes:15, nowMs:at(0) }, settings).store;
  const remind = extendDeclaration(store, 10, at(5), settings);
  assert.equal(remind.ok, true);
  assert.equal(remind.store.declaration.plannedMs, 25 * MIN);
  const capped = extendDeclaration(store, 10, at(5), strict);
  assert.equal(capped.addedMin, 5);
  assert.equal(capped.store.declaration.plannedMs, 20 * MIN);
  assert.deepEqual(extendDeclaration(capped.store, 5, at(6), strict), { ok:false, error:"今日消遣额度已用完（强制模式）" });
  assert.deepEqual(extendDeclaration(store, 5, at(16), settings), { ok:false, error:"小计时已经结束" });
  assert.equal(declarationRemainingMs(store, at(5)), 10 * MIN);
  assert.equal(normalizeCurrentSettings({}).accountingDisplay, "main");
});

test("控制器：小计时到点立即弹出黑屏，并带上刚结束的小计时", async () => {
  const plugin = accountingPlugin();
  const opened = [];
  plugin.openAccountingPrompt = (reason, tab, options) => { opened.push({ reason, tab, ended:options?.ended }); controller.setPromptOpen(true); };
  const clock = { value:at(0) };
  const { controller, events } = controllerFor(plugin, clock);
  controller._loaded = controller.load();
  await controller.poll();
  assert.deepEqual(controller.declare({ kind:"leisure", reason:"刷 X", minutes:2 }), { ok:true });
  clock.value = at(2) + 300;
  controller.checkExpiry();
  await tick();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].reason, "idle");
  assert.equal(opened[0].ended.reason, "刷 X");
  assert.ok(events.includes("beep-strong"));
  assert.equal(controller.view().declaration, null);
});
