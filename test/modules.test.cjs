const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeModuleDefinition,
  normalizeOrchestration,
  migrateLegacySettings,
  getNextModule,
  createModuleRunSnapshot
} = require("../src/core/modules.js");

function sequentialIds() {
  let n = 0;
  return () => `generated-${++n}`;
}

test("模块定义规范化保留稳定 ID，并给缺失字段安全默认值", () => {
  assert.deepEqual(normalizeModuleDefinition({
    id: "work-reading", type: "work", name: "  阅读  ", durationMin: 30.04,
    blackout: true, workspaceCommandId: "open-reading"
  }), {
    id: "work-reading", type: "work", name: "阅读", durationMin: 30,
    blackout: true, workspaceCommandId: "open-reading"
  });
  assert.deepEqual(normalizeModuleDefinition({ type: "rest", durationMin: 0 }, {
    id: "rest-default", fallbackName: "休息"
  }), {
    id: "rest-default", type: "rest", name: "休息", durationMin: 5, blackout: false
  });
});

test("旧 standard 配置迁移成工作、休息和普通长时工作模块", () => {
  const migrated = migrateLegacySettings({
    workMode: "standard", focusMin: 25, breakMin: 5, longFocusDefaultMin: 50,
    taskBlackoutEnabled: true, autoNext: true, projectEnable: true,
    currentProjectPath: "Projects/Research.md"
  }, { idFactory: sequentialIds() });
  assert.deepEqual(migrated.modules.map(({ id, type, name, durationMin, blackout }) => ({ id, type, name, durationMin, blackout })), [
    { id: "legacy-standard-work", type: "work", name: "工作", durationMin: 25, blackout: true },
    { id: "legacy-standard-rest", type: "rest", name: "休息", durationMin: 5, blackout: false },
    { id: "legacy-long-focus", type: "work", name: "长专注", durationMin: 50, blackout: true }
  ]);
  assert.deepEqual(migrated.projectAssignments, {
    "legacy-standard-work": "Projects/Research.md",
    "legacy-long-focus": "Projects/Research.md"
  });
  assert.equal(migrated.autoAdvance, true);
  assert.equal(migrated.enableProjects, true);
  assert.equal(migrated.loopMode, "infinite");
});

test("旧 A/B 和每 N 轮休息展开为线性模块序列，空任务名可安全运行", () => {
  const migrated = migrateLegacySettings({
    workMode: "cycle", cycleTaskA: "读论文", cycleTaskB: "写摘要",
    cycleMinA: 40, cycleMinB: 20, cycleBreakEvery: 2, breakMin: 10,
    currentProjectPath: "Projects/Paper.md"
  });
  assert.deepEqual(migrated.modules.map(module => [module.type, module.name, module.durationMin]), [
    ["work", "读论文", 40], ["work", "写摘要", 20],
    ["work", "读论文", 40], ["work", "写摘要", 20], ["rest", "休息", 10]
  ]);
  assert.equal(new Set(migrated.modules.map(module => module.id)).size, 5);
  assert.ok(migrated.modules.filter(module => module.type === "work").every(module => migrated.projectAssignments[module.id] === "Projects/Paper.md"));

  const missingNames = migrateLegacySettings({ workMode: "cycle", cycleBreakEvery: 0 });
  assert.deepEqual(missingNames.modules.map(module => module.name), ["工作 A", "工作 B"]);
  assert.ok(missingNames.modules.every(module => module.durationMin > 0));
});

test("已保存模块顺序与显式空序列优先于所有旧字段", () => {
  const custom = migrateLegacySettings({
    workMode: "cycle", modules: [{ id: "same", type: "work" }, { id: "same", type: "rest" }]
  }, { idFactory: sequentialIds() });
  assert.equal(custom.modules.length, 2);
  assert.equal(new Set(custom.modules.map(module => module.id)).size, 2);
  assert.deepEqual(migrateLegacySettings({
    modules: [{ id: "new-work", type: "work" }], currentProjectPath: "Projects/Old.md"
  }).projectAssignments, {});
  assert.deepEqual(migrateLegacySettings({ workMode: "cycle", modules: [] }).modules, []);
});

test("编排规则只在末项完成时计循环并支持无限、一次和 N 次", () => {
  const modules = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(normalizeOrchestration({ loopMode: "count", loopCount: 2.8, autoAdvance: 1, enableProjects: true }), {
    loopMode: "count", loopCount: 2, autoAdvance: false, enableProjects: true
  });
  assert.deepEqual(getNextModule(modules, 0, 0, { loopMode: "once" }), {
    nextIndex: 1, completedLoopCount: 0, shouldStop: false
  });
  assert.deepEqual(getNextModule(modules, 2, 0, { loopMode: "infinite" }), {
    nextIndex: 0, completedLoopCount: 1, shouldStop: false
  });
  assert.deepEqual(getNextModule(modules, 2, 0, { loopMode: "once" }), {
    nextIndex: null, completedLoopCount: 1, shouldStop: true
  });
  assert.deepEqual(getNextModule(modules, 2, 1, { loopMode: "count", loopCount: 2 }), {
    nextIndex: null, completedLoopCount: 2, shouldStop: true
  });
  assert.deepEqual(getNextModule([], 0, 4, { loopMode: "infinite" }), {
    nextIndex: null, completedLoopCount: 4, shouldStop: true
  });
});

test("运行快照冻结模块配置和启用时解析的项目关系", () => {
  const definition = { id: "work-a", type: "work", name: "写作", durationMin: 30, blackout: true, workspaceCommandId: "layout" };
  const assignments = { "work-a": "Projects/Essay.md" };
  const snapshot = createModuleRunSnapshot(definition, assignments, {
    enableProjects: true, runId: "run-fixed", startedAtMs: 123
  });
  definition.name = "被编辑后的名字";
  assignments["work-a"] = "Projects/Other.md";
  assert.deepEqual(snapshot, {
    runId: "run-fixed", moduleId: "work-a", type: "work", name: "写作",
    durationMin: 30, durationMs: 1_800_000, blackout: true,
    workspaceCommandId: "layout", projectPath: "Projects/Essay.md", startedAtMs: 123
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(createModuleRunSnapshot(definition, assignments, { enableProjects: false, runId: "run-2" }).projectPath, null);
  assert.equal(createModuleRunSnapshot({ ...definition, id: "rest-a", type: "rest" }, { "rest-a": "Projects/X.md" }, { enableProjects: true, runId: "run-3" }).projectPath, null);
});
