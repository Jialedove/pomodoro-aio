const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeClock, FakeVault, createPlugin, clone, FailureStore, PomodoroAIO } = require("./support.cjs");
const { createModuleDraft } = require("../src/core/module-draft.js");

function moduleSettings(overrides = {}) {
  return {
    modules: [
      { id:"work-reading", type:"work", name:"阅读", durationMin:30, blackout:false },
      { id:"rest-walk", type:"rest", name:"散步", durationMin:5, blackout:true }
    ],
    projectAssignments:{}, loopMode:"once", loopCount:1, autoAdvance:false,
    enableProjects:false, enableNotify:false, enableSound:false, ...overrides
  };
}

async function silenceExpectedError(fn) {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); }
  finally { console.error = original; }
}

test("模块编辑草稿只有保存才写入，保存失败可重试，旧草稿不能覆盖外部变化", async () => {
  const plugin = createPlugin({ settings:moduleSettings({
    restPresets:["NSDR 非睡眠深度休息", "在窗边看远方"],
    projectAssignments:{ "work-reading":"Projects/Reading.md" }
  }) });
  let writes = 0;
  plugin.saveSettings = async () => { writes += 1; };
  const draft = createModuleDraft(plugin.settings);
  draft.modules[0].name = "写笔记";
  draft.modules.splice(1, 1);
  draft.restPresetsText = "闭眼休息\n散步\n散步";
  assert.equal(writes, 0);
  assert.equal(plugin.settings.modules[0].name, "阅读");
  assert.equal(plugin.settings.modules.length, 2);
  await plugin.saveModuleDraft(draft);
  assert.equal(writes, 1);
  assert.deepEqual(plugin.settings.modules.map(module => module.name), ["写笔记"]);
  assert.deepEqual(plugin.settings.restPresets, ["闭眼休息", "散步"]);
  assert.deepEqual(plugin.settings.projectAssignments, { "work-reading":"Projects/Reading.md" });

  const failed = createModuleDraft(plugin.settings);
  failed.modules[0].durationMin = 40;
  plugin.saveSettings = async () => { throw new Error("disk failed"); };
  await assert.rejects(plugin.saveModuleDraft(failed), /disk failed/);
  assert.equal(plugin.settings.modules[0].durationMin, 30);
  assert.deepEqual(plugin.settings.restPresets, ["闭眼休息", "散步"]);
  plugin.saveSettings = async () => { writes += 1; };
  await plugin.updateModule("work-reading", { name:"外部更新" });
  await assert.rejects(plugin.saveModuleDraft(failed), /其他地方变化/);
  assert.equal(plugin.settings.modules[0].name, "外部更新");
  assert.equal(writes, 2);

  const invalid = createModuleDraft(plugin.settings);
  invalid.modules[0].durationMin = 0;
  await assert.rejects(plugin.saveModuleDraft(invalid), /时长须大于零/);
  invalid.modules[0].durationMin = 30;
  invalid.modules[0].invalidWorkspace = true;
  await assert.rejects(plugin.saveModuleDraft(invalid), /工作区须从候选中选择/);
  assert.equal(writes, 2);
});

test("模块序列将工作、休息和完整循环分别计数，休息不写番茄", async () => {
  const clock = new FakeClock(1_000);
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 阅读 0🍅\n" });
  const plugin = createPlugin({ vault, settings:moduleSettings() });
  await clock.run(() => plugin.startSequence());
  const startedRun = clone(plugin.runtime.moduleRun);
  assert.equal(startedRun.type, "work");
  assert.equal(plugin.runtime.durationMs, 30 * 60_000);
  await plugin.updateModule("work-reading", { name:"修改后的事情", durationMin:15, blackout:true });
  assert.equal(plugin.runtime.moduleRun.name, "阅读");
  assert.equal(plugin.runtime.durationMs, 30 * 60_000);

  clock.advance(30 * 60_000);
  await clock.run(() => plugin.tick());
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /阅读 1\.2🍅/);
  assert.equal(plugin.runtime.completedWorkCount, 1);
  assert.equal(plugin.runtime.completedRestCount, 0);
  assert.equal(plugin.runtime.status, "awaiting");
  assert.equal(plugin.runtime.attention.moduleRun.name, "散步");
  await clock.run(() => plugin.startPendingStage());
  assert.equal(plugin.runtime.moduleRun.type, "rest");
  clock.advance(60_000);
  await clock.run(() => plugin.completeCurrentModule());
  assert.equal(plugin.runtime.status, "idle");
  assert.equal(plugin.runtime.completedWorkCount, 1);
  assert.equal(plugin.runtime.completedRestCount, 1);
  assert.equal(plugin.runtime.completedLoopCount, 1);
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /阅读 1\.2🍅/);
});

test("工作开始时冻结项目关系；关闭项目后不访问项目仓储", async () => {
  const clock = new FakeClock(2_000);
  const vault = new FakeVault({
    "Daily/today.md":"- [ ] 阅读 0🍅\n",
    "Projects/X.md":"", "Projects/Y.md":""
  });
  const x = vault.getAbstractFileByPath("Projects/X.md");
  const y = vault.getAbstractFileByPath("Projects/Y.md");
  x.frontmatter = { "番茄数":0 };
  y.frontmatter = { "番茄数":0 };
  const settings = moduleSettings({
    modules:[{ id:"work-reading", type:"work", name:"阅读", durationMin:25, blackout:false }],
    projectAssignments:{ "work-reading":"Projects/X.md" }, enableProjects:true
  });
  const plugin = createPlugin({ vault, settings });
  const updates = [];
  plugin.app.workspace.trigger = (name, payload) => {
    if (name === "pomodoro:aio-project-updated") updates.push(payload);
  };
  await clock.run(() => plugin.startSequence());
  await plugin.setModuleProject("work-reading", "Projects/Y.md");
  assert.equal(plugin.runtime.moduleRun.projectPath, "Projects/X.md");
  clock.advance(25 * 60_000);
  await clock.run(() => plugin.tick());
  assert.equal(x.frontmatter["番茄数"], 1);
  assert.equal(y.frontmatter["番茄数"], 0);
  assert.deepEqual(updates, [{ path:"Projects/X.md", tomatoes:1 }]);

  const noProject = createPlugin({ vault:new FakeVault({ "Daily/today.md":"- [ ] 阅读 0🍅\n" }),
    settings:moduleSettings({ modules:settings.modules, projectAssignments:settings.projectAssignments, enableProjects:false }) });
  noProject._getProjectRepository = () => { throw new Error("project repository must stay unplugged"); };
  await clock.run(() => noProject.startSequence());
  clock.advance(25 * 60_000);
  await clock.run(() => noProject.tick());
  assert.equal(noProject.runtime.status, "idle");
  assert.match(noProject.app.vault.getAbstractFileByPath("Daily/today.md").content, /阅读 1🍅/);
});

test("模块工作结算从持久化 journal 恢复而不重复写日记", async () => {
  const clock = new FakeClock(3_000);
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 阅读 0🍅\n" });
  const stateStore = new FailureStore();
  const settings = moduleSettings({ modules:[{ id:"work-reading", type:"work", name:"阅读", durationMin:25, blackout:false }] });
  const plugin = createPlugin({ vault, settings, stateStore });
  await clock.run(() => plugin.startSequence());
  let failOnce = true;
  const originalProcess = vault.process.bind(vault);
  vault.process = async (file, callback) => {
    const result = await originalProcess(file, callback);
    if (failOnce) { failOnce = false; throw new Error("interrupted after daily write"); }
    return result;
  };
  clock.advance(25 * 60_000);
  await silenceExpectedError(() => clock.run(() => plugin.tick()));
  assert.ok(plugin.runtime.pendingSettlement);
  assert.equal(plugin.runtime.status, "settlement-failed");
  await plugin.flushPendingSaves();
  vault.process = originalProcess;
  const persisted = await stateStore.load();
  const resumed = createPlugin({ vault, settings,
    runtime:PomodoroAIO.normalizeRuntime(persisted, PomodoroAIO.normalizeSettings(settings), clock.now()), stateStore });
  await clock.run(() => resumed.recoverPendingSettlement());
  assert.equal(resumed.runtime.pendingSettlement, null);
  assert.equal(resumed.runtime.status, "idle");
  assert.equal(resumed.runtime.completedWorkCount, 1);
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /阅读 1🍅/);
  assert.equal((vault.getAbstractFileByPath("Daily/today.md").content.match(/阅读/g) || []).length, 1);
});

test("休息转换中断后恢复同一下一模块，休息与循环不重复计数", async () => {
  const clock = new FakeClock(4_000);
  const settings = moduleSettings({
    modules:[
      { id:"rest-walk", type:"rest", name:"散步", durationMin:5, blackout:false },
      { id:"work-reading", type:"work", name:"阅读", durationMin:25, blackout:false }
    ], autoAdvance:true
  });
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 阅读 0🍅\n" });
  const stateStore = new FailureStore();
  const plugin = createPlugin({ vault, settings, stateStore });
  await clock.run(() => plugin.startSequence());
  const originalStartModule = plugin.startModule.bind(plugin);
  let failOnce = true;
  plugin.startModule = async (...args) => {
    if (failOnce) { failOnce = false; throw new Error("interrupted before next module"); }
    return originalStartModule(...args);
  };
  clock.advance(5 * 60_000);
  await silenceExpectedError(() => clock.run(() => plugin.tick()));
  assert.equal(plugin.runtime.status, "settlement-failed");
  assert.ok(plugin.runtime.pendingBreakTransition);
  await plugin.flushPendingSaves();
  const persisted = await stateStore.load();
  const resumed = createPlugin({ vault, settings,
    runtime:PomodoroAIO.normalizeRuntime(persisted, PomodoroAIO.normalizeSettings(settings), clock.now()), stateStore });
  await clock.run(() => resumed.recoverPendingBreakTransition());
  assert.equal(resumed.runtime.status, "running");
  assert.equal(resumed.runtime.moduleRun.moduleId, "work-reading");
  assert.equal(resumed.runtime.pendingBreakTransition, null);
  assert.equal(resumed.runtime.completedRestCount, 1);
  assert.equal(resumed.runtime.completedLoopCount, 0);
});

test("零时长完成工作只推进模块，不创建番茄 journal", async () => {
  const clock = new FakeClock(5_000);
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 阅读 0🍅\n" });
  const plugin = createPlugin({ vault, settings:moduleSettings() });
  await clock.run(() => plugin.startSequence());
  await clock.run(() => plugin.completeCurrentModule());
  assert.equal(plugin.runtime.status, "awaiting");
  assert.equal(plugin.runtime.completedWorkCount, 1);
  assert.equal(plugin.runtime.pendingSettlement, null);
  assert.equal(plugin.runtime.pendingBreakTransition, null);
  assert.equal(vault.getAbstractFileByPath("Daily/today.md").content, "- [ ] 阅读 0🍅\n");
});

test("单个工作模块完成事情时勾选对应日记待办，并清空该模块与临时项目关系", async () => {
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 阅读\n- [ ] 写作\n" });
  const plugin = createPlugin({ vault, settings:moduleSettings({
    modules:[
      { id:"work-reading", type:"work", name:"阅读", durationMin:25, blackout:true, workspaceCommandId:"layout-reading" },
      { id:"work-writing", type:"work", name:"写作", durationMin:25, blackout:false }
    ],
    projectAssignments:{ "work-reading":"Projects/X.md" }, enableProjects:true
  }) });
  assert.equal(await plugin.completeTask({ moduleId:"work-reading" }), true);
  assert.equal(vault.getAbstractFileByPath("Daily/today.md").content, "- [x] 阅读\n- [ ] 写作\n");
  assert.equal(plugin.settings.modules[0].name, "工作");
  assert.equal(plugin.settings.modules[0].workspaceCommandId, "");
  assert.equal(plugin.settings.modules[0].blackout, false);
  assert.equal(plugin.settings.projectAssignments["work-reading"], undefined);
  assert.equal(plugin.settings.modules[1].name, "写作");
});

test("单个运行中工作模块完成事情先结算有效时长，重名待办不提前结束", async () => {
  const clock = new FakeClock(5_500);
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 阅读 0🍅\n- [ ] 阅读 0🍅\n" });
  const plugin = createPlugin({ vault, settings:moduleSettings() });
  await clock.run(() => plugin.startSequence());
  clock.advance(10 * 60_000);
  assert.equal(await silenceExpectedError(() => clock.run(() => plugin.completeTask({ moduleId:"work-reading" }))), false);
  assert.equal(plugin.runtime.status, "running");
  assert.equal(vault.getAbstractFileByPath("Daily/today.md").content, "- [ ] 阅读 0🍅\n- [ ] 阅读 0🍅\n");
  vault.getAbstractFileByPath("Daily/today.md").content = "- [ ] 阅读 0🍅\n";
  assert.equal(await clock.run(() => plugin.completeTask({ moduleId:"work-reading" })), true);
  assert.equal(plugin.runtime.status, "awaiting");
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /- \[x\] 阅读 0\.4🍅/);
  assert.equal(plugin.settings.modules[0].name, "工作");
});

test("待确认工作在真正开始时读取最新项目关系", async () => {
  const clock = new FakeClock(6_000);
  const settings = moduleSettings({
    modules:[
      { id:"rest-walk", type:"rest", name:"散步", durationMin:5, blackout:false },
      { id:"work-reading", type:"work", name:"阅读", durationMin:25, blackout:false }
    ],
    projectAssignments:{ "work-reading":"Projects/X.md" }, enableProjects:true
  });
  const plugin = createPlugin({ settings, vault:new FakeVault({ "Daily/today.md":"- [ ] 阅读 0🍅\n" }) });
  await clock.run(() => plugin.startSequence());
  clock.advance(5 * 60_000);
  await clock.run(() => plugin.tick());
  assert.equal(plugin.runtime.status, "awaiting");
  await plugin.setModuleProject("work-reading", "Projects/Y.md");
  await plugin.updateModule("work-reading", { name:"写摘要", durationMin:40 });
  await clock.run(() => plugin.startPendingStage());
  assert.equal(plugin.runtime.moduleRun.projectPath, "Projects/Y.md");
  assert.equal(plugin.runtime.moduleRun.name, "写摘要");
  assert.equal(plugin.runtime.durationMs, 40 * 60_000);
});

test("双击选择使用的模块索引按稳定 ID 持久化，重排后从选中的休息开始", async () => {
  const clock = new FakeClock(6_500);
  const settings = moduleSettings({ modules:[
    { id:"work-reading", type:"work", name:"阅读", durationMin:25, blackout:false },
    { id:"rest-walk", type:"rest", name:"散步", durationMin:5, blackout:false },
    { id:"work-writing", type:"work", name:"写作", durationMin:25, blackout:false }
  ] });
  const stateStore = new FailureStore();
  const plugin = createPlugin({ settings, stateStore });
  assert.equal(await clock.run(() => plugin.selectModule(1)), true);
  assert.equal(plugin.runtime.status, "idle");
  assert.equal(plugin.runtime.selectedModuleId, "rest-walk");
  assert.equal(plugin.snapshot().runtime.nextModule.id, "rest-walk");
  await plugin.moveModule("rest-walk", 2);
  await plugin.flushPendingSaves();
  const restored = PomodoroAIO.normalizeRuntime(await stateStore.load(), PomodoroAIO.normalizeSettings(plugin.settings), clock.now());
  assert.equal(restored.selectedModuleId, "rest-walk");
  assert.equal(restored.currentModuleIndex, 2);
  const resumed = createPlugin({ settings:plugin.settings, runtime:restored });
  await clock.run(() => resumed.startSequence());
  assert.equal(resumed.runtime.moduleRun.moduleId, "rest-walk");
  assert.equal(resumed.runtime.currentModuleIndex, 2);
});

test("待确认时可改选下一模块，正在运行时拒绝覆盖当前执行快照", async () => {
  const clock = new FakeClock(6_750);
  const settings = moduleSettings({ modules:[
    { id:"work-reading", type:"work", name:"阅读", durationMin:1, blackout:false },
    { id:"rest-walk", type:"rest", name:"散步", durationMin:5, blackout:false },
    { id:"work-writing", type:"work", name:"写作", durationMin:25, blackout:false }
  ] });
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 阅读 0🍅\n- [ ] 写作 0🍅\n" });
  const plugin = createPlugin({ settings, vault });
  await clock.run(() => plugin.startSequence());
  clock.advance(60_000);
  await clock.run(() => plugin.tick());
  assert.equal(plugin.runtime.status, "awaiting");
  assert.equal(plugin.runtime.attention.moduleRun.moduleId, "rest-walk");
  assert.equal(await clock.run(() => plugin.selectModule(2)), true);
  assert.equal(plugin.runtime.attention.moduleRun.moduleId, "work-writing");
  assert.equal(plugin.runtime.currentModuleIndex, 2);
  await clock.run(() => plugin.startPendingStage());
  assert.equal(plugin.runtime.moduleRun.moduleId, "work-writing");
  const runId = plugin.runtime.moduleRun.runId;
  assert.equal(await clock.run(() => plugin.selectModule(1)), false);
  assert.equal(plugin.runtime.moduleRun.runId, runId);
});

test("模块项目写入失败保留重试，已成功的日记结算不回滚", async () => {
  const clock = new FakeClock(7_000);
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 阅读 0🍅\n", "Projects/X.md":"" });
  const project = vault.getAbstractFileByPath("Projects/X.md");
  project.frontmatter = { "番茄数":0 };
  const settings = moduleSettings({
    modules:[{ id:"work-reading", type:"work", name:"阅读", durationMin:25, blackout:false }],
    projectAssignments:{ "work-reading":"Projects/X.md" }, enableProjects:true
  });
  const plugin = createPlugin({ vault, settings });
  const original = plugin.app.fileManager.processFrontMatter;
  plugin.app.fileManager.processFrontMatter = async (file, callback) => {
    if (file.path === "Projects/X.md") throw new Error("project unavailable");
    return original(file, callback);
  };
  await clock.run(() => plugin.startSequence());
  clock.advance(25 * 60_000);
  await silenceExpectedError(() => clock.run(() => plugin.tick()));
  assert.equal(plugin.runtime.status, "idle");
  assert.equal(plugin.runtime.pendingSettlement, null);
  assert.equal(plugin.runtime.projectQueue.length, 1);
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /阅读 1🍅/);
  assert.equal(project.frontmatter["番茄数"], 0);
});

test("自动衔接按指定完整循环次数停止，休息序列始终不写日记", async () => {
  const clock = new FakeClock(8_000);
  const vault = new FakeVault({ "Daily/today.md":"" });
  const plugin = createPlugin({ vault, settings:moduleSettings({
    modules:[{ id:"rest-walk", type:"rest", name:"散步", durationMin:1, blackout:false }],
    loopMode:"count", loopCount:2, autoAdvance:true
  }) });
  await clock.run(() => plugin.startSequence());
  clock.advance(60_000);
  await clock.run(() => plugin.tick());
  assert.equal(plugin.runtime.status, "running");
  assert.equal(plugin.runtime.completedLoopCount, 1);
  clock.advance(60_000);
  await clock.run(() => plugin.tick());
  assert.equal(plugin.runtime.status, "idle");
  assert.equal(plugin.runtime.completedRestCount, 2);
  assert.equal(plugin.runtime.completedWorkCount, 0);
  assert.equal(plugin.runtime.completedLoopCount, 2);
  assert.equal(vault.getAbstractFileByPath("Daily/today.md").content, "");
});

test("暂停后重载保留工作执行快照与剩余时间", async () => {
  const clock = new FakeClock(9_000);
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 阅读 0🍅\n" });
  const stateStore = new FailureStore();
  const settings = moduleSettings({ modules:[{ id:"work-reading", type:"work", name:"阅读", durationMin:30, blackout:false }] });
  const plugin = createPlugin({ vault, stateStore, settings });
  await clock.run(() => plugin.startSequence());
  const runId = plugin.runtime.moduleRun.runId;
  clock.advance(5 * 60_000);
  await clock.run(() => plugin.togglePause());
  await plugin.updateModule("work-reading", { name:"新名称", durationMin:15 });
  await plugin.flushPendingSaves();
  const restored = PomodoroAIO.normalizeRuntime(await stateStore.load(), PomodoroAIO.normalizeSettings(plugin.settings), clock.now());
  assert.equal(restored.status, "paused");
  assert.equal(restored.moduleRun.runId, runId);
  assert.equal(restored.moduleRun.name, "阅读");
  assert.equal(restored.durationMs, 30 * 60_000);
  assert.equal(restored.remainingMs, 25 * 60_000);
  const resumed = createPlugin({ vault, stateStore, settings:plugin.settings, runtime:restored });
  clock.advance(60 * 60_000);
  await clock.run(() => resumed.togglePause());
  assert.equal(clock.runSync(() => resumed.getLeftMs()), 25 * 60_000);
  clock.advance(25 * 60_000);
  await clock.run(() => resumed.tick());
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /阅读 1\.2🍅/);
});
