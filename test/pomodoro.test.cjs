const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CommandSimulator,
  FailureStore,
  FakeClock,
  FakeVault,
  PomodoroAIO,
  clone,
  createPlugin
} = require("./support.cjs");

async function silenceConsoleError(fn) {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); }
  finally { console.error = original; }
}

test("计时基线：剩余时间由绝对开始时间计算", () => {
  const clock = new FakeClock(1_000);
  const plugin = createPlugin({
    runtime: { status: "running", stage: "focus", startedAtMs: 1_000, durationMs: 1_500_000 }
  });

  assert.equal(clock.runSync(() => plugin.getLeftMs()), 1_500_000);
  clock.advance(1_250);
  assert.equal(clock.runSync(() => plugin.getLeftMs()), 1_498_750);
});

test("快速记录复用逻辑当日日记并区分待办与想法", async () => {
  const vault = new FakeVault({ "Daily/today.md": "# 日记\n" });
  const plugin = createPlugin({ vault, settings:{ captureHeading:"收集箱" } });

  await plugin.quickCapture("稍后处理\n第二部分", "todo");
  await plugin.quickCapture("新的方向", "idea");

  assert.equal(
    vault.getAbstractFileByPath("Daily/today.md").content,
    "# 日记\n\n## 收集箱\n\n- [ ] 稍后处理 第二部分\n- 新的方向\n"
  );
  assert.deepEqual(plugin.notices.slice(-2), ["待办已记入当日日记", "想法已记入当日日记"]);
});

test("空的快速记录不会创建当日日记", async () => {
  const vault = new FakeVault();
  const plugin = createPlugin({ vault });

  await assert.rejects(() => plugin.quickCapture("  \n ", "todo"), /内容为空/);
  assert.equal(vault.getAbstractFileByPath("Daily/today.md"), null);
});

test("普通模式：开始自定义专注保留任务并折算番茄额度", async () => {
  const clock = new FakeClock(10_000);
  const plugin = createPlugin({ runtime: { currentTaskName: "写测试" } });

  await clock.run(() => plugin.startFocus({ minutes: 15, suppressNotify: true }));

  assert.equal(plugin.runtime.status, "running");
  assert.equal(plugin.runtime.stage, "focus");
  assert.equal(plugin.runtime.durationMs, 900_000);
  assert.equal(plugin.runtime.currentTaskName, "写测试");
  assert.equal(plugin.runtime.plannedTomatoCredit, 0.6);
});

test("普通模式：自动进入休息后 Ribbon 点击只关闭提醒", async () => {
  const clock = new FakeClock(20_000);
  const plugin = createPlugin({
    settings: { autoNext: true, longEvery: 4 },
    vault: new FakeVault({ "Daily/today.md": "- [ ] 完成报告 0🍅\n" }),
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: 20_000 - 25 * 60 * 1000,
      durationMs: 25 * 60 * 1000,
      currentTaskName: "完成报告"
    }
  });
  await silenceConsoleError(() => clock.run(() => plugin.tick()));
  assert.match(plugin.app.vault.getAbstractFileByPath("Daily/today.md").content, /完成报告 1🍅/);
  assert.equal(plugin.runtime.status, "running");
  assert.equal(plugin.runtime.stage, "break");
  assert.equal(plugin.runtime.attention.type, "break");
  assert.equal(plugin.runtime.attention.nextStarted, true);
  const duration = plugin.runtime.durationMs;
  const startedAt = plugin.runtime.startedAtMs;

  await clock.run(() => plugin.onRibbonClick());
  assert.equal(plugin.runtime.status, "running");
  assert.equal(plugin.runtime.stage, "break");
  assert.equal(plugin.runtime.durationMs, duration);
  assert.equal(plugin.runtime.startedAtMs, startedAt);
  assert.equal(plugin.runtime.attention, null);
});

test("循环模式：A/B 交替、额度和布局命令保持一致", async () => {
  const clock = new FakeClock(100_000);
  const commands = new CommandSimulator([
    { id: "workspaces-plus:研究", name: "Workspaces Plus: Load: 研究" },
    { id: "workspaces-plus:整理", name: "Workspaces Plus: Load: 整理" },
    { id: "workspaces-plus:open", name: "Open Workspaces Plus" }
  ], "整理");
  const plugin = createPlugin({
    vault: new FakeVault({ "Daily/today.md": "- [ ] 简单任务 0🍅\n" }),
    commands,
    activeWorkspace: "整理",
    settings: {
      workMode: "cycle",
      cycleTaskA: "难任务",
      cycleMinA: 15,
      cycleWorkspaceCommandA: "workspaces-plus:研究",
      cycleTaskB: "简单任务",
      cycleMinB: 30,
      cycleWorkspaceCommandB: "workspaces-plus:整理"
    }
  });
  assert.equal(plugin.selectCycleSlot(1), true);
  assert.deepEqual(
    plugin.getWorkspaceLayoutCommands().map(command => command.id).sort(),
    ["workspaces-plus:研究", "workspaces-plus:整理"].sort()
  );

  await clock.run(() => plugin.startCycle());
  assert.equal(plugin.runtime.currentTaskName, "简单任务");
  assert.equal(plugin.runtime.plannedTomatoCredit, 1.2);
  assert.deepEqual(commands.executed, []);

  plugin.runtime.startedAtMs = clock.now() - plugin.runtime.durationMs;
  await silenceConsoleError(() => clock.run(() => plugin.tick()));
  assert.match(plugin.app.vault.getAbstractFileByPath("Daily/today.md").content, /简单任务 1.2🍅/);
  assert.equal(plugin.runtime.status, "awaiting");
  assert.equal(plugin.runtime.attention.cycleSlot, 0);

  const changedSettings = { ...plugin.settings, cycleTaskA: "已改名任务", cycleMinA: 45 };
  const restored = createPlugin({
    vault: plugin.app.vault,
    commands,
    settings: changedSettings,
    runtime: PomodoroAIO.normalizeRuntime(JSON.parse(JSON.stringify(plugin.runtime)), changedSettings, clock.now())
  });

  await clock.run(() => restored.onRibbonClick());
  assert.equal(restored.runtime.currentTaskName, "难任务");
  assert.equal(restored.runtime.status, "running");
  assert.equal(restored.runtime.stage, "focus");
  assert.equal(restored.runtime.durationMs, 900_000);
  assert.deepEqual(commands.executed, ["workspaces-plus:研究"]);
});

test("待确认休息使用持久化时长，不受设置修改影响", async () => {
  const clock = new FakeClock(150_000);
  const plugin = createPlugin({
    settings: { autoNext: false, breakMin: 5 },
    vault: new FakeVault({ "Daily/today.md": "- [ ] 设置快照 0🍅\n" }),
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: clock.now() - 25 * 60 * 1000,
      durationMs: 25 * 60 * 1000,
      currentTaskName: "设置快照"
    }
  });

  await clock.run(() => plugin.tick());
  assert.equal(plugin.runtime.status, "awaiting");
  assert.equal(plugin.runtime.attention.durationMs, 300_000);

  const changedSettings = { ...plugin.settings, breakMin: 30 };
  const restored = createPlugin({
    vault: plugin.app.vault,
    settings: changedSettings,
    runtime: PomodoroAIO.normalizeRuntime(JSON.parse(JSON.stringify(plugin.runtime)), changedSettings, clock.now())
  });
  await clock.run(() => restored.onRibbonClick());
  assert.equal(restored.runtime.stage, "break");
  assert.equal(restored.runtime.durationMs, 300_000);
});

test("自然完成按计划时长折算，手动完成按实际运行时长折算", async () => {
  const clock = new FakeClock(500_000);
  for (const [minutes, expected] of [[15, 0.6], [25, 1], [30, 1.2], [50, 2]]) {
    const plugin = createPlugin({
      settings: { autoNext: false },
      vault: new FakeVault({ "Daily/today.md": "- [ ] 自然完成 0🍅\n" }),
      runtime: {
        status: "running",
        stage: "focus",
        startedAtMs: clock.now() - minutes * 60 * 1000,
        durationMs: minutes * 60 * 1000,
        currentTaskName: "自然完成"
      }
    });
    await clock.run(() => plugin.tick());
    assert.match(plugin.app.vault.getAbstractFileByPath("Daily/today.md").content, new RegExp(`自然完成 ${expected}🍅`));
  }

  const manual = createPlugin({
    vault: new FakeVault({ "Daily/today.md": "- [ ] 手动完成 0🍅\n" }),
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: clock.now() - 5 * 60 * 1000,
      durationMs: 25 * 60 * 1000,
      currentTaskName: "手动完成"
    }
  });
  await clock.run(() => manual.forceCompleteFocusOnce());
  assert.match(manual.app.vault.getAbstractFileByPath("Daily/today.md").content, /手动完成 0.2🍅/);
  assert.equal(manual.runtime.sessionCount, 1);
  assert.equal(manual.runtime.status, "running");
  assert.equal(manual.runtime.stage, "break");
});

test("立即手动完成不会凭空写入番茄", async () => {
  const clock = new FakeClock(600_000);
  const vault = new FakeVault({ "Daily/today.md": "- [ ] 零时长 0🍅\n" });
  const plugin = createPlugin({
    vault,
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: clock.now(),
      durationMs: 25 * 60 * 1000,
      currentTaskName: "零时长"
    }
  });

  await clock.run(() => plugin.forceCompleteFocusOnce());
  assert.equal(plugin.runtime.status, "running");
  assert.equal(plugin.runtime.stage, "focus");
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /零时长 0🍅/);
});

test("暂停/继续按累计有效运行时间计算，不累加暂停漂移", async () => {
  const clock = new FakeClock(1_000_000);
  const plugin = createPlugin({
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: clock.now(),
      durationMs: 3_600_000
    }
  });
  let activeMs = 0;
  for (let i = 0; i < 100; i++) {
    clock.advance(1_234);
    activeMs += 1_234;
    await clock.run(() => plugin.togglePause());
    assert.equal(plugin.runtime.status, "paused");
    assert.equal(plugin.runtime.elapsedMs, activeMs);
    clock.advance(98_765);
    assert.equal(clock.runSync(() => plugin.getLeftMs()), 3_600_000 - activeMs);
    await clock.run(() => plugin.togglePause());
    assert.equal(plugin.runtime.status, "running");
  }
  assert.equal(clock.runSync(() => plugin.getElapsedMs()), activeMs);
  assert.equal(clock.runSync(() => plugin.getLeftMs()), 3_600_000 - activeMs);
});

test("到点时点击暂停直接进入结算，不会卡在零剩余暂停态", async () => {
  const clock = new FakeClock(1_100_000);
  const vault = new FakeVault({ "Daily/today.md": "- [ ] 边界暂停 0🍅\n" });
  const plugin = createPlugin({
    vault,
    settings: { autoNext: false },
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: clock.now() - 25 * 60 * 1000,
      durationMs: 25 * 60 * 1000,
      currentTaskName: "边界暂停"
    }
  });

  const paused = await clock.run(() => plugin.togglePause());
  assert.equal(paused, false);
  assert.equal(plugin.runtime.status, "awaiting");
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /边界暂停 1🍅/);
});

test("休息阶段同样支持暂停、恢复和重置", async () => {
  const clock = new FakeClock(2_000_000);
  const plugin = createPlugin({ runtime: { currentTaskName: "休息测试" } });

  await clock.run(() => plugin.startBreak(true, { suppressNotify: true }));
  assert.equal(plugin.runtime.status, "running");
  assert.equal(plugin.runtime.stage, "break");
  clock.advance(2_000);
  await clock.run(() => plugin.togglePause());
  assert.equal(plugin.runtime.status, "paused");
  const left = plugin.runtime.remainingMs;
  clock.advance(60_000);
  assert.equal(clock.runSync(() => plugin.getLeftMs()), left);
  await clock.run(() => plugin.togglePause());
  assert.equal(plugin.runtime.status, "running");

  await plugin.reset(false);
  assert.equal(plugin.runtime.status, "idle");
  assert.equal(plugin.runtime.stage, null);
  assert.equal(plugin.runtime.startedAtMs, 0);
});

test("结算快照明确不自动进入休息时不受当前设置覆盖", async () => {
  const plugin = createPlugin({ settings: { autoNext: true } });

  await plugin.startBreak(false, {
    forceRun: false,
    allowTransition: true,
    suppressNotify: true
  });

  assert.equal(plugin.runtime.status, "awaiting");
  assert.equal(plugin.runtime.stage, null);
  assert.equal(plugin.runtime.remainingMs, 5 * 60 * 1000);
});

test("设置和运行态迁移会拒绝非法值并移除旧字段", () => {
  const settings = PomodoroAIO.normalizeSettings({
    focusMin: "bad",
    dayStartHHMM: "99:99",
    fallbackPattern: "Daily//{{date:YYYY-MM-DD}}.md",
    currentProjectPath: "../Projects/demo.md"
  });
  assert.equal(settings.focusMin, 25);
  assert.equal(settings.dayStartHHMM, "00:00");
  assert.equal(settings.fallbackPattern, "Daily/{{date:YYYY-MM-DD}}.md");
  assert.equal(settings.currentProjectPath, "");

  const runtime = PomodoroAIO.normalizeRuntime({
    phase: "focus",
    startedAt: 1_000,
    durationSec: 1_500,
    paused: false,
    tomatoCredit: 0.6
  }, settings, 2_000);
  assert.equal(runtime.status, "running");
  assert.equal(runtime.stage, "focus");
  assert.equal(runtime.durationMs, 1_500_000);
  assert.equal(runtime.plannedTomatoCredit, 1);
  assert.equal(runtime.phase, undefined);
  assert.equal(runtime.startedAt, undefined);
});

test("损坏 journal 在加载时隔离并允许重置", async () => {
  const settings = PomodoroAIO.normalizeSettings({});
  const runtime = PomodoroAIO.normalizeRuntime({
    status: "settlement-failed",
    stage: "focus",
    sessionId: "broken-session",
    durationMs: 25 * 60 * 1000,
    pendingSettlement: { schemaVersion: 1, sessionId: "broken-session" }
  }, settings, 2_000);
  const plugin = createPlugin({ runtime });

  assert.equal(runtime.pendingSettlement, null);
  assert.equal(runtime.quarantinedSettlement.sessionId, "broken-session");
  assert.match(runtime.failure.message, /已隔离/);
  assert.equal(await plugin.reset(false), true);
  assert.equal(plugin.runtime.status, "idle");
});

test("journal 与重试队列中的非法路径在加载时被隔离", async () => {
  const plugin = createPlugin({
    runtime:{ sessionId:"unsafe-path", currentTaskName:"路径检查", durationMs:25 * 60 * 1000 }
  });
  const journal = await plugin.prepareSettlement(
    1,
    { mode:"standard", isLong:false, autoNext:false, durationMs:300_000 },
    1
  );
  journal.daily.path = "../Daily/today.md";
  const runtime = PomodoroAIO.normalizeRuntime({
    status:"settling",
    stage:"focus",
    pendingSettlement:journal,
    projectQueue:[{ sessionId:"project", path:"Projects//bad.md", key:"番茄数" }],
    frontmatterQueue:[{ path:"Daily\\bad.md", key:"番茄数" }]
  }, plugin.settings, 2_000);

  assert.equal(runtime.pendingSettlement, null);
  assert.match(runtime.quarantinedSettlement.error, /路径非法/);
  assert.deepEqual(runtime.projectQueue, []);
  assert.deepEqual(runtime.frontmatterQueue, []);
});

test("旧循环待确认状态缺少任务快照时仍可按当前设置恢复", async () => {
  const plugin = createPlugin({ settings: {
    workMode: "cycle",
    cycleTaskA: "当前任务 A",
    cycleMinA: 15,
    cycleTaskB: "当前任务 B",
    cycleMinB: 30
  } });
  const settings = plugin.settings;
  const runtime = PomodoroAIO.normalizeRuntime({
    status: "awaiting",
    mode: "cycle",
    attention: { type: "focus", cycleSlot: 0, nextStarted: false, durationMs: 900_000 }
  }, settings, 2_000);
  plugin.runtime = runtime;

  await plugin.startPendingStage();
  assert.equal(plugin.runtime.currentTaskName, "当前任务 A");
  assert.equal(plugin.runtime.durationMs, 900_000);
});

test("逻辑日期在一天开始时间前后正确切换", () => {
  const plugin = createPlugin({ settings: { dayStartHHMM: "04:00" } });
  assert.equal(plugin.logicalTodayKey(new Date(2026, 7, 6, 3, 59)), "2026-08-05");
  assert.equal(plugin.logicalTodayKey(new Date(2026, 7, 6, 4, 0)), "2026-08-06");
});

test("日记基线：精确匹配、优先未完成并保留复选框", async () => {
  const vault = new FakeVault({
    "Daily/today.md": "- [x] C++ [x] 🧠 1🍅\n  - [ ] C++ [x] 🧠 2🍅"
  });
  const plugin = createPlugin({
    vault,
    runtime: { currentTaskName: "C++ [x] 🧠" }
  });

  const sum = await plugin.applyTomatoAndSum(0.5);
  const file = vault.getAbstractFileByPath("Daily/today.md");

  assert.equal(sum, 3.5);
  assert.match(file.content, /^- \[x\] C\+\+ \[x\] 🧠 1🍅$/m);
  assert.match(file.content, /^  - \[ \] C\+\+ \[x\] 🧠 2.5🍅$/m);
  assert.equal(file.frontmatter.番茄数, 3.5);
});

test("日记基线：未找到任务时按设置插入新任务", async () => {
  const vault = new FakeVault({ "Daily/today.md": "# 任务\n" });
  const plugin = createPlugin({
    vault,
    settings: { tasksHeading: "# 任务", allowAutoCreateTask: true },
    runtime: { currentTaskName: "新任务" }
  });

  await plugin.applyTomatoAndSum(0.2);

  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /- \[ \] 新任务 0.2🍅/);
});

test("正式结算拒绝空任务名，不生成畸形任务行", async () => {
  const vault = new FakeVault({ "Daily/today.md": "# 任务\n" });
  const plugin = createPlugin({
    vault,
    runtime: {
      sessionId: "empty-task-session",
      durationMs: 25 * 60 * 1000,
      currentTaskName: "   "
    }
  });

  await assert.rejects(
    () => plugin.prepareSettlement(
      1,
      { mode: "standard", isLong: false, autoNext: false, durationMs: 5 * 60 * 1000 },
      1
    ),
    /任务名为空/
  );
  assert.equal(vault.getAbstractFileByPath("Daily/today.md").content, "# 任务\n");
});

test("原子任务变换保留 CRLF/缩进，并按完整任务名匹配", async () => {
  const task = "A+B (测试) ✅";
  const vault = new FakeVault({
    "Daily/today.md": `- [ ] A+B (测试) ✅ other 1🍅\r\n  - [ ] ${task} 2🍅\r\n- [ ] A+B (测试) ✅ extra 9🍅`
  });
  const plugin = createPlugin({ vault, runtime: { currentTaskName: task } });

  await plugin.applyTomatoAndSum(0.5);
  const content = vault.getAbstractFileByPath("Daily/today.md").content;
  assert.match(content, /  - \[ \] A\+B \(测试\) ✅ 2.5🍅/);
  assert.match(content, /\r\n/);
  assert.match(content, /A\+B \(测试\) ✅ other 1🍅/);
  assert.match(content, /A\+B \(测试\) ✅ extra 9🍅/);
  assert.equal(content.endsWith("\n"), false);
});

test("日记成功、项目失败时保留项目重试且不重复写日记", async () => {
  const clock = new FakeClock(6_000_000);
  const daily = new FakeVault({
    "Daily/today.md": "- [ ] 派生任务 0🍅\n",
    "Projects/demo.md": "---\n番茄数: 1\n---\n"
  });
  const project = daily.getAbstractFileByPath("Projects/demo.md");
  project.frontmatter = { "番茄数": 1 };
  const plugin = createPlugin({
    vault: daily,
    settings: { autoNext: false, currentProjectPath: "Projects/demo.md" },
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: clock.now() - 25 * 60 * 1000,
      durationMs: 25 * 60 * 1000,
      currentTaskName: "派生任务"
    }
  });
  const processFrontMatter = plugin.app.fileManager.processFrontMatter;
  plugin.app.fileManager.processFrontMatter = async (file, callback) => {
    if (file.path === "Projects/demo.md") throw new Error("项目暂不可写");
    return processFrontMatter(file, callback);
  };

  await silenceConsoleError(() => clock.run(() => plugin.tick()));
  assert.match(daily.getAbstractFileByPath("Daily/today.md").content, /派生任务 1🍅/);
  assert.equal(project.frontmatter["番茄数"], 1);
  assert.equal(plugin.runtime.pendingSettlement, null);
  assert.equal(plugin.runtime.projectQueue.length, 1);

  plugin.app.fileManager.processFrontMatter = processFrontMatter;
  await plugin.drainProjectQueue();
  assert.equal(project.frontmatter["番茄数"], 2);
  assert.equal(plugin.runtime.projectQueue.length, 0);
  assert.match(daily.getAbstractFileByPath("Daily/today.md").content, /派生任务 1🍅/);
});

test("项目重试队列按加入顺序处理", async () => {
  const plugin = createPlugin({
    runtime: {
      projectQueue: [
        { sessionId: "s1", path: "Projects/first.md", status: "pending" },
        { sessionId: "s2", path: "Projects/second.md", status: "pending" }
      ]
    }
  });
  const visited = [];
  plugin.applyProjectPlan = async item => {
    visited.push(item.path);
    return { status: "pending", error: "仍不可写" };
  };

  await silenceConsoleError(() => plugin.drainProjectQueue());
  assert.deepEqual(visited, ["Projects/first.md", "Projects/second.md"]);
  assert.deepEqual(plugin.runtime.projectQueue.map(item => item.path), visited);
});

test("项目重试单项异常不会阻塞后续队列", async () => {
  const plugin = createPlugin({
    runtime: {
      projectQueue: [
        { sessionId: "s1", path: "Projects/throw.md", status: "pending" },
        { sessionId: "s2", path: "Projects/apply.md", status: "pending" }
      ]
    }
  });
  plugin.applyProjectPlan = async item => {
    if (item.path.endsWith("throw.md")) throw new Error("项目 API 异常");
    return { status: "applied" };
  };

  await silenceConsoleError(() => plugin.drainProjectQueue());
  assert.deepEqual(plugin.runtime.projectQueue.map(item => item.path), ["Projects/throw.md"]);
  assert.match(plugin.runtime.projectQueue[0].error, /项目 API 异常/);
});

test("同一项目的连续重试按额度顺序重算，避免丢记一段", async () => {
  const plugin = createPlugin({
    runtime: {
      projectQueue: [
        { sessionId: "s1", path: "Projects/same.md", key: "番茄数", amount: 1, beforeValue: 0, afterValue: 1, status: "pending" },
        { sessionId: "s2", path: "Projects/same.md", key: "番茄数", amount: 1, beforeValue: 0, afterValue: 1, status: "pending" }
      ]
    }
  });
  const seen = [];
  plugin.applyProjectPlan = async item => {
    seen.push([item.sessionId, item.beforeValue, item.afterValue]);
    return { status: "applied" };
  };

  await plugin.drainProjectQueue();
  assert.deepEqual(seen, [["s1", 0, 1], ["s2", 1, 2]]);
  assert.equal(plugin.runtime.projectQueue.length, 0);
});

test("任务行成功但汇总失败时只进入修复队列", async () => {
  const vault = new FakeVault({ "Daily/today.md": "- [ ] 汇总任务 0🍅\n" });
  const plugin = createPlugin({ runtime: { currentTaskName: "汇总任务" }, vault });
  const processFrontMatter = plugin.app.fileManager.processFrontMatter;
  plugin.app.fileManager.processFrontMatter = async () => { throw new Error("汇总暂不可写"); };

  await silenceConsoleError(() => plugin.applyTomatoAndSum(1));
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /汇总任务 1🍅/);
  assert.equal(plugin.runtime.frontmatterQueue.length, 1);
  assert.match(plugin.savedStates.at(-1).frontmatterQueue[0].error, /汇总暂不可写/);

  await silenceConsoleError(() => plugin.repairFrontmatterQueue());
  assert.match(plugin.savedStates.at(-1).frontmatterQueue[0].error, /汇总暂不可写/);

  plugin.app.fileManager.processFrontMatter = processFrontMatter;
  await plugin.repairFrontmatterQueue();
  assert.equal(vault.getAbstractFileByPath("Daily/today.md").frontmatter["番茄数"], 1);
  assert.equal(plugin.runtime.frontmatterQueue.length, 0);
});

test("项目基线：标签和状态白名单兼容 frontmatter 数组与字符串", () => {
  const vault = new FakeVault({
    "Projects/a.md": "",
    "Projects/b.md": "",
    "Projects/c.md": ""
  });
  const metadata = new Map([
    ["Projects/a.md", { frontmatter: { tags: ["project"], "项目状态": "进行中" } }],
    ["Projects/b.md", { frontmatter: { tags: "#project", "项目状态": "筹划中" } }],
    ["Projects/c.md", { frontmatter: { tags: ["project"], "项目状态": "已完成" } }]
  ]);
  const plugin = createPlugin({ vault, metadata });

  assert.deepEqual(
    plugin.projectCandidates().map(project => project.path),
    ["Projects/a.md", "Projects/b.md"]
  );
});

test("测试基础设施：时钟、命令和故障存储可注入", async () => {
  const clock = new FakeClock(42);
  clock.advance(8);
  assert.equal(clock.now(), 50);

  const commands = new CommandSimulator([{ id: "demo", name: "Demo" }]);
  assert.equal(commands.executeCommandById("demo"), true);
  assert.deepEqual(commands.executed, ["demo"]);

  const store = new FailureStore({ version: 1 });
  store.failNext("save");
  await assert.rejects(() => store.save({ version: 2 }), /injected save failure/);
  await store.save({ version: 2 });
  assert.deepEqual(await store.load(), { version: 2 });
});

test("运行态保存使用不可变快照并按调用顺序串行落盘", async () => {
  const store = new FailureStore(null, { saveDelays: [30, 0] });
  const plugin = createPlugin({ stateStore: store });

  plugin.runtime.sessionCount = 1;
  const first = plugin.saveState();
  plugin.runtime.sessionCount = 2;
  const second = plugin.saveState();
  await Promise.all([first, second]);

  assert.equal(store.saves.length, 2);
  assert.equal(store.saves[0].sessionCount, 1);
  assert.equal(store.saves[1].sessionCount, 2);
  assert.equal(store.value.sessionCount, 2);
});

test("计时阶段转换使用关键保存，失败时回滚到可重试状态", async () => {
  const now = Date.now();
  const cases = [
    ["开始专注", {}, plugin => plugin.startFocus({ suppressNotify:true })],
    ["开始休息", {}, plugin => plugin.startBreak(false, { suppressNotify:true })],
    ["暂停", { status:"running", stage:"focus", startedAtMs:now - 1_000, durationMs:60_000 }, plugin => plugin.togglePause()],
    ["继续", { status:"paused", stage:"focus", elapsedMs:1_000, remainingMs:59_000, durationMs:60_000, pausedAtMs:now }, plugin => plugin.togglePause()],
    ["重置", { status:"running", stage:"focus", startedAtMs:now, durationMs:60_000 }, plugin => plugin.reset(false)],
    ["开启强提醒", {}, plugin => plugin.beginStrongAlert({ type:"focus", durationMs:60_000 })],
    ["关闭强提醒", { status:"awaiting", attention:{ type:"focus", isLong:false, cycleSlot:null, nextStarted:false, durationMs:60_000 } }, plugin => plugin.stopStrongAlert()]
  ];

  for (const [name, runtime, action] of cases) {
    const store = new FailureStore();
    store.failNext("save");
    const plugin = createPlugin({ stateStore:store, runtime });
    const before = clone(plugin.runtime);

    await assert.rejects(
      () => silenceConsoleError(() => action(plugin)),
      error => error.message === "injected save failure",
      name
    );
    assert.deepEqual(plugin.runtime, before, name);
    assert.equal(store.saves.length, 0, name);
  }
});

test("休息转换在各保存边界中断后都恢复到同一段专注", async () => {
  const clock = new FakeClock(5_500_000);
  for (const failAt of [2, 3, 4]) {
    const store = new FailureStore();
    const save = store.save.bind(store);
    let saveCount = 0;
    store.save = async value => {
      saveCount += 1;
      if (saveCount === failAt) throw new Error(`injected transition failure ${failAt}`);
      await save(value);
    };
    const settings = { autoNext:true, focusMin:25 };
    const plugin = createPlugin({
      stateStore:store,
      settings,
      runtime:{ status:"running", stage:"break", startedAtMs:clock.now() - 300_000, durationMs:300_000 }
    });

    await silenceConsoleError(() => clock.run(() => plugin.settleBreak()));
    await plugin.flushPendingSaves();
    assert.equal(plugin.runtime.status, "settlement-failed", `save ${failAt}`);
    assert.ok(plugin.runtime.pendingBreakTransition, `save ${failAt}`);

    const persisted = await store.load();
    const startedAtMs = persisted.stage === "focus" ? persisted.startedAtMs : null;
    const restored = createPlugin({
      stateStore:store,
      settings,
      runtime:PomodoroAIO.normalizeRuntime(persisted, settings, clock.now())
    });
    await silenceConsoleError(() => clock.run(() => restored.recoverPendingBreakTransition()));
    await restored.flushPendingSaves();

    assert.equal(restored.runtime.status, "running", `save ${failAt}`);
    assert.equal(restored.runtime.stage, "focus", `save ${failAt}`);
    assert.equal(restored.runtime.durationMs, 25 * 60 * 1000, `save ${failAt}`);
    assert.equal(restored.runtime.pendingBreakTransition, null, `save ${failAt}`);
    assert.equal(restored.runtime.attention.nextStarted, true, `save ${failAt}`);
    if (startedAtMs) assert.equal(restored.runtime.startedAtMs, startedAtMs, `save ${failAt}`);
  }
});

test("待确认专注按休息转换快照恢复，不受当前设置覆盖", async () => {
  const settings = { ...createPlugin().settings, autoNext:true, focusMin:50 };
  const runtime = PomodoroAIO.normalizeRuntime({
    status:"settling",
    stage:"break",
    durationMs:300_000,
    startedAtMs:1_000,
    pendingBreakTransition:{
      schemaVersion:1,
      status:"break-completing",
      autoNext:false,
      durationMs:15 * 60 * 1000,
      createdAtMs:2_000
    }
  }, settings, 3_000);
  const plugin = createPlugin({ settings, runtime });

  assert.equal(plugin.runtime.status, "settling");
  await plugin.recoverPendingBreakTransition();

  assert.equal(plugin.runtime.status, "awaiting");
  assert.equal(plugin.runtime.stage, null);
  assert.equal(plugin.runtime.attention.nextStarted, false);
  assert.equal(plugin.runtime.attention.durationMs, 15 * 60 * 1000);
  assert.equal(plugin.runtime.pendingBreakTransition, null);

  const invalid = PomodoroAIO.normalizeRuntime({
    status:"settling",
    stage:"break",
    pendingBreakTransition:{ schemaVersion:1, status:"break-completing", autoNext:false }
  }, settings, 3_000);
  assert.equal(invalid.pendingBreakTransition, null);
  assert.equal(invalid.status, "settlement-failed");
  assert.equal(await createPlugin({ settings, runtime:invalid }).reset(false), true);
});

test("并发 tick 只会应用一次日记结算", async () => {
  const clock = new FakeClock(3_000_000);
  const vault = new FakeVault({ "Daily/today.md": "- [ ] 并发任务 0🍅\n" });
  const plugin = createPlugin({
    vault,
    settings: { autoNext: false },
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: clock.now() - 25 * 60 * 1000,
      durationMs: 25 * 60 * 1000,
      currentTaskName: "并发任务"
    }
  });

  const first = clock.runSync(() => plugin.tick());
  const second = clock.runSync(() => plugin.tick());
  await Promise.all([first, second]);

  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /并发任务 1🍅/);
  assert.doesNotMatch(vault.getAbstractFileByPath("Daily/today.md").content, /并发任务 2🍅/);
  assert.equal(plugin.runtime.sessionCount, 1);
});

test("日记已应用但结算中断时，重载恢复不会重复记账", async () => {
  const clock = new FakeClock(4_000_000);
  const vault = new FakeVault({ "Daily/today.md": "- [ ] 恢复任务 0🍅\n" });
  const store = new FailureStore();
  const options = {
    vault,
    stateStore: store,
    settings: { autoNext: false },
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: clock.now() - 25 * 60 * 1000,
      durationMs: 25 * 60 * 1000,
      currentTaskName: "恢复任务"
    }
  };
  const plugin = createPlugin(options);
  const process = vault.process.bind(vault);
  vault.process = async (file, callback) => {
    assert.ok(store.value?.pendingSettlement, "日记写入前必须先落盘 journal");
    return process(file, callback);
  };
  const originalApplyProject = plugin.applyProjectSettlement.bind(plugin);
  plugin.applyProjectSettlement = async journal => {
    if (!plugin.crashed) {
      plugin.crashed = true;
      throw new Error("模拟结算中断");
    }
    return originalApplyProject(journal);
  };

  await silenceConsoleError(() => clock.run(() => plugin.tick()));
  await plugin.flushPendingSaves();
  assert.equal(plugin.runtime.status, "settlement-failed");
  assert.ok(plugin.runtime.pendingSettlement);
  assert.equal(plugin.runtime.failure.operation, "settleFocus");
  assert.equal(plugin.runtime.failure.stage, "focus");
  assert.equal(plugin.runtime.failure.target, "Daily/today.md");
  assert.equal(plugin.runtime.failure.step, "prepareOrResume");
  assert.match(plugin.runtime.failure.message, /模拟结算中断/);
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /恢复任务 1🍅/);

  const restored = createPlugin(options);
  restored.runtime = PomodoroAIO.normalizeRuntime(await store.load(), restored.settings, clock.now());
  await clock.run(() => restored.resumePendingSettlement());
  await restored.flushPendingSaves();

  const content = vault.getAbstractFileByPath("Daily/today.md").content;
  assert.match(content, /恢复任务 1🍅/);
  assert.doesNotMatch(content, /恢复任务 2🍅/);
  assert.equal(restored.runtime.pendingSettlement, null);
  assert.equal(restored.runtime.sessionCount, 1);
});

test("恢复时缺失的日记文件只按 journal 固定路径创建", async () => {
  const vault = new FakeVault();
  const plugin = createPlugin({
    vault,
    settings: { autoNext: false },
    runtime: {
      sessionId: "yesterday-session",
      durationMs: 25 * 60 * 1000,
      currentTaskName: "昨天任务"
    }
  });
  plugin.todayFilePath = () => "Daily/yesterday.md";
  const journal = await plugin.prepareSettlement(
    1,
    { mode: "standard", isLong: false, autoNext: false, durationMs: 5 * 60 * 1000 },
    1
  );
  plugin.todayFilePath = () => "Daily/today.md";

  await plugin.applyDailySettlement(journal);

  assert.match(vault.getAbstractFileByPath("Daily/yesterday.md").content, /昨天任务 1🍅/);
  assert.equal(vault.getAbstractFileByPath("Daily/today.md"), null);
});

test("休息已启动但提醒尚未落盘时恢复不会重置休息计时", async () => {
  const clock = new FakeClock(4_250_000);
  const vault = new FakeVault({ "Daily/today.md": "- [ ] 休息恢复 0🍅\n" });
  const plugin = createPlugin({
    vault,
    settings: { autoNext: true },
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: clock.now() - 25 * 60 * 1000,
      durationMs: 25 * 60 * 1000,
      currentTaskName: "休息恢复"
    }
  });
  plugin.beginStrongAlert = () => { throw new Error("模拟提醒写入前崩溃"); };

  await silenceConsoleError(() => clock.run(() => plugin.tick()));
  assert.equal(plugin.runtime.stage, "break");
  assert.equal(plugin.runtime.status, "settlement-failed");
  const startedAt = plugin.runtime.startedAtMs;
  const pending = JSON.parse(JSON.stringify(plugin.runtime.pendingSettlement));

  clock.advance(1_234);
  const restored = createPlugin({
    vault,
    settings: { autoNext: true },
    runtime: PomodoroAIO.normalizeRuntime({
      ...plugin.runtime,
      pendingSettlement: pending
    }, { ...plugin.settings, autoNext: true }, clock.now())
  });
  await clock.run(() => restored.resumePendingSettlement());

  assert.equal(restored.runtime.status, "running");
  assert.equal(restored.runtime.stage, "break");
  assert.equal(restored.runtime.startedAtMs, startedAt);
  assert.equal(restored.runtime.pendingSettlement, null);
});

test("插件启动先恢复结算与重试队列，再启动调度器", async () => {
  const plugin = new PomodoroAIO();
  const order = [];
  const ribbon = {
    onclick: null,
    addClass() {},
    removeClass() {},
    createDiv() { return { setText() {} }; }
  };
  plugin.loadSettings = async () => {
    order.push("settings");
    plugin.settings = PomodoroAIO.normalizeSettings({});
  };
  plugin.loadState = async () => {
    order.push("state");
    return null;
  };
  plugin.saveState = async () => { order.push("save"); };
  plugin.recoverPendingSettlement = async () => { order.push("recover"); };
  plugin.recoverPendingBreakTransition = async () => { order.push("break-recover"); };
  plugin.repairFrontmatterQueue = async () => { order.push("frontmatter"); };
  plugin.drainProjectQueue = async () => { order.push("project"); };
  plugin.registerView = () => { order.push("view"); };
  plugin.addCommand = () => {};
  plugin.addRibbonIcon = () => ribbon;
  plugin.addSettingTab = () => {};
  plugin.applyStrongAlertStateFromRuntime = () => {};
  plugin.updateRibbonVisuals = () => {};
  plugin.logicalTodayKey = () => "2026-08-06";
  plugin.app = {
    workspace: {
      onLayoutReady() { order.push("layout-ready"); },
      getLeavesOfType() { return []; }
    }
  };
  const previousWindow = globalThis.window;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  globalThis.window = {
    setTimeout(callback) {
      order.push("scheduler");
      return nativeSetTimeout(callback, 60_000);
    },
    clearTimeout: nativeClearTimeout
  };
  try {
    await plugin.onload();
    const schedulerIndex = order.indexOf("scheduler");
    assert.ok(schedulerIndex > order.indexOf("recover"));
    assert.ok(schedulerIndex > order.indexOf("break-recover"));
    assert.ok(schedulerIndex > order.indexOf("frontmatter"));
    assert.ok(schedulerIndex > order.indexOf("project"));
    assert.deepEqual(order.slice(0, 7), ["settings", "state", "save", "recover", "break-recover", "frontmatter", "project"]);
  } finally {
    await plugin.onunload();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("journal 无法持久化时不执行日记写入", async () => {
  const clock = new FakeClock(4_500_000);
  const store = new FailureStore();
  store.failNext("save");
  const vault = new FakeVault({ "Daily/today.md": "- [ ] 保存失败任务 0🍅\n" });
  const plugin = createPlugin({
    vault,
    stateStore: store,
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: clock.now() - 25 * 60 * 1000,
      durationMs: 25 * 60 * 1000,
      currentTaskName: "保存失败任务"
    }
  });
  let processCount = 0;
  const process = vault.process.bind(vault);
  vault.process = async (file, callback) => {
    processCount += 1;
    return process(file, callback);
  };

  await silenceConsoleError(() => clock.run(() => plugin.tick()));
  await plugin.flushPendingSaves();
  assert.equal(processCount, 0);
  assert.equal(plugin.runtime.status, "settlement-failed");
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /保存失败任务 0🍅/);
});

test("存在未完成 journal 时重置不会覆盖或丢失结算", async () => {
  const pending = { sessionId: "pending-session", status: "prepared", daily: { path: "Daily/today.md" } };
  const plugin = createPlugin({
    runtime: {
      status: "settlement-failed",
      stage: "focus",
      sessionId: "pending-session",
      pendingSettlement: pending
    }
  });

  assert.equal(await plugin.reset(false), false);
  assert.equal(plugin.runtime.status, "settlement-failed");
  assert.deepEqual(plugin.runtime.pendingSettlement, pending);
});

test("存在未完成 journal 时启动命令不会覆盖旧结算", async () => {
  const pending = { sessionId: "pending-session", status: "prepared", daily: { path: "Daily/today.md" } };
  const plugin = createPlugin({
    runtime: {
      status: "settlement-failed",
      stage: "focus",
      sessionId: "pending-session",
      pendingSettlement: pending
    }
  });

  assert.equal(await plugin.startFocus({ minutes: 25, suppressNotify: true }), false);
  assert.equal(await plugin.startBreak(false, { suppressNotify: true }), false);
  assert.equal(plugin.runtime.status, "settlement-failed");
  assert.deepEqual(plugin.runtime.pendingSettlement, pending);
});

test("活动阶段不能被开始命令覆盖当前 session", async () => {
  const plugin = createPlugin({
    settings: { workMode:"cycle", cycleTaskA:"A", cycleTaskB:"B" },
    runtime: {
      status: "running",
      stage: "focus",
      sessionId: "active-session",
      durationMs: 1_500_000,
      currentTaskName: "当前任务"
    }
  });

  assert.equal(await plugin.startFocus({ minutes:15, suppressNotify:true }), false);
  assert.equal(await plugin.startBreak(false, { suppressNotify:true }), false);
  assert.equal(await plugin.startCycle(0), false);
  assert.equal(plugin.runtime.sessionId, "active-session");
  assert.equal(plugin.runtime.durationMs, 1_500_000);
  assert.equal(plugin.runtime.currentTaskName, "当前任务");
});

test("日记目标行被外部修改时进入冲突，不覆盖用户内容", async () => {
  const clock = new FakeClock(5_000_000);
  const vault = new FakeVault({ "Daily/today.md": "- [ ] 冲突任务 0🍅\n" });
  const plugin = createPlugin({
    vault,
    settings: { autoNext: false },
    runtime: {
      status: "running",
      stage: "focus",
      startedAtMs: clock.now() - 25 * 60 * 1000,
      durationMs: 25 * 60 * 1000,
      currentTaskName: "冲突任务"
    }
  });
  const process = vault.process.bind(vault);
  let edited = false;
  vault.process = async (file, callback) => {
    if (!edited) {
      edited = true;
      file.content = "- [ ] 冲突任务 0.5🍅\n";
    }
    return process(file, callback);
  };

  await silenceConsoleError(() => clock.run(() => plugin.tick()));
  assert.equal(plugin.runtime.status, "settlement-failed");
  assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /冲突任务 0\.5🍅/);
  assert.doesNotMatch(vault.getAbstractFileByPath("Daily/today.md").content, /冲突任务 1\.5🍅/);
});
