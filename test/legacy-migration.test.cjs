const test = require("node:test");
const assert = require("node:assert/strict");
const { PomodoroAIO, FakeClock, FakeVault, createPlugin } = require("./support.cjs");
const { createRuntimeDefaults } = require("../src/legacy/runtime-normalization.js");

test("V5 设置只持久化模块模型，不保留旧模式和长专注字段", () => {
  const settings = PomodoroAIO.normalizeSettings({
    workMode:"standard", focusMin:25, breakMin:5, longFocusDefaultMin:50,
    currentProjectPath:"Projects/Old.md"
  });
  assert.equal(settings.schemaVersion, 5);
  assert.deepEqual(settings.modules.map(module => [module.type, module.durationMin]), [["work",25],["rest",5]]);
  for (const key of ["workMode", "cycleTaskA", "cycleTaskB", "cycleBreakEvery", "longFocusDefaultMin", "currentProjectPath"]) {
    assert.equal(Object.hasOwn(settings, key), false, key);
  }
});

test("新运行态默认值不含旧字段；旧运行段不推断项目归属", () => {
  const settings = PomodoroAIO.normalizeSettings({ focusMin:25, breakMin:5 });
  settings.enableProjects = true;
  settings.projectAssignments[settings.modules[0].id] = "Projects/New.md";
  const defaults = createRuntimeDefaults(settings);
  for (const key of ["cycleSlot", "cycleRoundCount", "currentTaskName", "longFocusMinutes", "breakContinuation"]) {
    assert.equal(Object.hasOwn(defaults, key), false, key);
  }
  const upgraded = PomodoroAIO.normalizeRuntime({
    schemaVersion:4, status:"running", stage:"focus", mode:"standard",
    startedAtMs:1000, durationMs:1_500_000, sessionId:"old-run", currentTaskName:"旧工作"
  }, settings, 2000);
  assert.equal(upgraded.moduleRun.projectPath, null);
});

test("升级时运行中的旧长专注保留当前时长并成为可恢复的模块快照", () => {
  const settings = PomodoroAIO.normalizeSettings({ focusMin:25, breakMin:5, longFocusDefaultMin:50 });
  const runtime = PomodoroAIO.normalizeRuntime({
    schemaVersion:4, status:"running", stage:"focus", mode:"standard", isLong:true,
    startedAtMs:1000, durationMs:3_000_000, sessionId:"old-long", currentTaskName:"写论文",
    longFocusMinutes:50
  }, settings, 2000);
  assert.equal(runtime.schemaVersion, 5);
  assert.equal(runtime.mode, "modules");
  assert.equal(runtime.durationMs, 3_000_000);
  assert.equal(runtime.moduleRun.name, "写论文");
  assert.equal(runtime.moduleRun.durationMs, 3_000_000);
  assert.equal(runtime.moduleRun.runId, "old-long");
  assert.equal(Object.hasOwn(runtime, "longFocusMinutes"), false);
});

test("旧待确认阶段升级后只保留模块快照，不持久化嵌套旧字段", () => {
  const settings = PomodoroAIO.normalizeSettings({ focusMin:25, breakMin:5 });
  const runtime = PomodoroAIO.normalizeRuntime({
    schemaVersion:4, status:"awaiting", stage:null, mode:"standard",
    attention:{ type:"focus", isLong:true, cycleSlot:0, taskName:"旧任务", nextStarted:false, durationMs:3_000_000 }
  }, settings, 2000);
  assert.equal(runtime.attention.moduleRun.name, "旧任务");
  for (const key of ["isLong", "cycleSlot", "taskName"]) {
    assert.equal(Object.hasOwn(runtime.attention, key), false, key);
  }
  const plugin = createPlugin({ settings:{ ...settings, enableSound:false, enableNotify:false }, runtime });
  return plugin.startPendingStage().then(() => {
    assert.equal(plugin.runtime.moduleRun.durationMs, 3_000_000);
    assert.equal(plugin.runtime.moduleRun.recoveryOnly, true);
  });
});

test("升级中的旧长专注完成一次日记结算后停止，不插入普通序列", async () => {
  const clock = new FakeClock(3_001_000);
  const settings = PomodoroAIO.normalizeSettings({ focusMin:25, breakMin:5, longFocusDefaultMin:50 });
  const runtime = PomodoroAIO.normalizeRuntime({
    schemaVersion:4, status:"running", stage:"focus", mode:"standard",
    startedAtMs:1000, durationMs:3_000_000, sessionId:"old-long", currentTaskName:"写论文",
    longFocusMinutes:50
  }, settings, clock.now());
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 写论文 0🍅\n" });
  const plugin = createPlugin({ vault, settings:{ ...settings, enableNotify:false, enableSound:false }, runtime });
  await clock.run(() => plugin.tick());
  assert.equal(plugin.runtime.status, "idle");
  assert.equal(plugin.runtime.pendingSettlement, null);
  assert.equal(plugin.runtime.completedWorkCount, 1);
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /写论文 2🍅/);
});

test("旧结算 journal 升级后继续完成，不重复写入日记", async () => {
  const clock = new FakeClock(2_000_000);
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 写论文 0🍅\n" });
  const old = createPlugin({ vault, settings:{ autoNext:false }, runtime:{
    status:"running", stage:"focus", mode:"standard", startedAtMs:clock.now() - 1_500_000,
    durationMs:1_500_000, sessionId:"legacy-journal", currentTaskName:"写论文"
  } });
  const process = vault.process.bind(vault);
  let once = true;
  vault.process = async (file, callback) => {
    const result = await process(file, callback);
    if (once) { once = false; throw new Error("interrupted after daily write"); }
    return result;
  };
  const originalError = console.error;
  console.error = () => {};
  try { await clock.run(() => old.tick()); }
  finally { console.error = originalError; }
  assert.ok(old.runtime.pendingSettlement);
  vault.process = process;

  const settings = PomodoroAIO.normalizeSettings({ focusMin:25, breakMin:5 });
  const runtime = PomodoroAIO.normalizeRuntime({ ...old.runtime, schemaVersion:4 }, settings, clock.now());
  assert.equal(runtime.pendingSettlement.transition.mode, "modules");
  const upgraded = createPlugin({ vault, settings:{ ...settings, enableSound:false, enableNotify:false }, runtime });
  await clock.run(() => upgraded.recoverPendingSettlement());
  assert.equal(upgraded.runtime.pendingSettlement, null);
  assert.equal(upgraded.runtime.status, "idle");
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /写论文 1🍅/);
  assert.equal((vault.getAbstractFileByPath("Daily/today.md").content.match(/写论文/g) || []).length, 1);
});
