const assert = require("node:assert");
const fs = require("node:fs");
const Module = require("node:module");

const source = fs.readFileSync("src/main.js", "utf8");
const workspacesSource = fs.readFileSync("src/integrations/workspaces-plus.js", "utf8");
const viewSource = fs.readFileSync("src/ui/pomodoro-view.js", "utf8");
assert.doesNotMatch(source, /registerEvent\(this\.app\.workspace\.onLayoutReady/);
assert.match(viewSource, /clearTaskBtn\.onpointerdown/);
assert.match(viewSource, /clearProjBtn\.onpointerdown/);
assert.match(viewSource, /clearCycleWorkspaceA\.onpointerdown/);
assert.match(viewSource, /clearCycleWorkspaceB\.onpointerdown/);
assert.match(source, /this\._unloading = true/);
assert.match(viewSource, /const lockCycleA = cycleRunning && r\.cycleSlot === 0/);
assert.match(viewSource, /const lockCycleB = cycleRunning && r\.cycleSlot === 1/);
assert.match(viewSource, /cycleRowA\.ondblclick/);
assert.match(viewSource, /cycleRowB\.ondblclick/);
assert.match(workspacesSource, /command\?\.id\?\.startsWith\(WORKSPACES_PLUS_PREFIX\)/);
assert.match(viewSource, /list:"pmdCycleWorkspaceListA"/);
assert.match(viewSource, /list:"pmdCycleWorkspaceListB"/);
assert.match(fs.readFileSync("styles.css", "utf8"), /pmd-datalist-opening .pmd-clear/);
assert.match(fs.readFileSync("styles.css", "utf8"), /pmd-cycle-workspace/);

const originalLoad = Module._load;
const FakeTFile = class {};
Module._load = (request, parent, isMain) => request === "obsidian"
  ? {
      Plugin: class {},
      Notice: class {},
      TFile: FakeTFile,
      ItemView: class {},
      PluginSettingTab: class {},
      Setting: class {},
      normalizePath: path => String(path || "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "")
    }
  : originalLoad(request, parent, isMain);

const PomodoroAIO = require("../src/main.js");
const { positiveNumber } = require("../src/core/validation.js");
Module._load = originalLoad;

assert.equal(positiveNumber("-1", 25), 25);
assert.equal(positiveNumber("0", 25), 25);
assert.equal(positiveNumber("1.5", 25), 1.5);
assert.equal(PomodoroAIO.workspaceLayoutLabel({ name: "Workspaces Plus: Load: 研究" }), "研究");

const plugin = new PomodoroAIO();
plugin.settings = {
  cycleTaskA: "难任务",
  cycleMinA: 15,
  cycleWorkspaceCommandA: "workspaces-plus:研究",
  cycleTaskB: "简单任务",
  cycleMinB: 30,
  cycleWorkspaceCommandB: "workspaces-plus:整理",
  enableSound: false,
  enableNotify: false,
  persistentAlertSound: false,
  ribbonClickAutoNext: true,
  focusStartCommandId: "",
  projectEnable: false,
  allowAutoCreateTask: true,
  fmKey: "番茄数"
  , workMode: "cycle"
};
plugin.runtime = {
  schemaVersion: 3,
  status: "idle",
  stage: null,
  mode: "cycle",
  durationMs: 0,
  startedAtMs: 0,
  elapsedMs: 0,
  remainingMs: 0,
  pausedAtMs: 0,
  sessionId: null,
  plannedTomatoCredit: 1,
  sessionCount: 0,
  cycleSlot: 0,
  attention: null,
  pendingSettlement: null,
  pendingBreakTransition: null,
  projectQueue: [],
  frontmatterQueue: [],
  currentTaskName: "",
  longFocusMinutes: 50
};
plugin.ensureDayFreshness = () => {};
plugin.saveState = () => {};
plugin.broadcast = () => {};
plugin.executedCommands = [];
const todayFile = new FakeTFile();
todayFile.path = "Daily/today.md";
todayFile.content = "- [ ] 简单任务 0🍅\n";
todayFile.frontmatter = {};
plugin.todayFilePath = () => todayFile.path;
plugin.app = {
  vault: {
    getAbstractFileByPath: path => path === todayFile.path ? todayFile : null,
    read: async file => file.content,
    process: async (file, callback) => { file.content = await callback(file.content); }
  },
  fileManager: {
    async processFrontMatter(file, callback) { await callback(file.frontmatter); }
  },
  metadataCache: { getFileCache: () => ({}) },
  internalPlugins: {
    getPluginById: id => id === "workspaces" ? { instance:{ activeWorkspace:"整理" } } : null
  },
  commands: {
    executeCommandById: id => { plugin.executedCommands.push(id); return true; },
    listCommands: () => [
      { id: "workspaces-plus:研究", name: "Workspaces Plus: Load: 研究" },
      { id: "workspaces-plus:整理", name: "Workspaces Plus: Load: 整理" },
      { id: "workspaces-plus:open-workspaces-plus", name: "Open Workspaces Plus" },
      { id: "other:command", name: "Load: 其他" }
    ]
  }
};

assert.equal(plugin.selectCycleSlot(1), true);
assert.equal(plugin.runtime.cycleSlot, 1);
assert.deepEqual(plugin.getWorkspaceLayoutCommands().map(command => command.id).sort(), ["workspaces-plus:研究", "workspaces-plus:整理"].sort());
(async () => {
  await plugin.startCycle();
  assert.equal(plugin.runtime.currentTaskName, "简单任务");
  assert.equal(plugin.runtime.plannedTomatoCredit, 1.2);
  assert.deepEqual(plugin.executedCommands, []);
  assert.equal(plugin.selectCycleSlot(0), false);
  plugin.runtime.startedAtMs = Date.now() - plugin.runtime.durationMs;

  await plugin.tick();
  assert.match(todayFile.content, /简单任务 1.2🍅/);
  assert.equal(plugin.runtime.status, "awaiting");
  assert.equal(plugin.runtime.attention.cycleSlot, 0);
  assert.equal(plugin.getLeftSec(), 900);

  await plugin.onRibbonClick();
  assert.equal(plugin.runtime.currentTaskName, "难任务");
  assert.equal(plugin.runtime.status, "running");
  assert.equal(plugin.runtime.stage, "focus");
  assert.equal(plugin.runtime.durationMs, 900_000);
  assert.deepEqual(plugin.executedCommands, ["workspaces-plus:研究"]);
  console.log("cycle mode check passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
