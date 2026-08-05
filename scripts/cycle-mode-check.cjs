const assert = require("node:assert");
const fs = require("node:fs");
const Module = require("node:module");

const source = fs.readFileSync("src/main.js", "utf8");
assert.doesNotMatch(source, /registerEvent\(this\.app\.workspace\.onLayoutReady/);
assert.match(source, /clearTaskBtn\.onpointerdown/);
assert.match(source, /clearProjBtn\.onpointerdown/);
assert.match(source, /clearCycleWorkspaceA\.onpointerdown/);
assert.match(source, /clearCycleWorkspaceB\.onpointerdown/);
assert.match(source, /this\._unloading = true/);
assert.match(source, /const lockCycleA = r\.cycleActive && r\.cycleSlot === 0/);
assert.match(source, /const lockCycleB = r\.cycleActive && r\.cycleSlot === 1/);
assert.match(source, /cycleRowA\.ondblclick/);
assert.match(source, /cycleRowB\.ondblclick/);
assert.match(source, /command\?\.id\?\.startsWith\("workspaces-plus:"\)/);
assert.match(source, /list:"pmdCycleWorkspaceListA"/);
assert.match(source, /list:"pmdCycleWorkspaceListB"/);
assert.match(fs.readFileSync("styles.css", "utf8"), /pmd-datalist-opening .pmd-clear/);
assert.match(fs.readFileSync("styles.css", "utf8"), /pmd-cycle-workspace/);

const originalLoad = Module._load;
Module._load = (request, parent, isMain) => request === "obsidian"
  ? {
      Plugin: class {},
      Notice: class {},
      TFile: class {},
      ItemView: class {},
      PluginSettingTab: class {},
      Setting: class {}
    }
  : originalLoad(request, parent, isMain);

const PomodoroAIO = require("../src/main.js");
const positiveNumber = Function("require", "module", `${source}\nreturn positiveNumber;`)(require, {});
const workspaceLayoutLabel = Function("require", "module", `${source}\nreturn workspaceLayoutLabel;`)(require, {});
Module._load = originalLoad;

assert.equal(positiveNumber("-1", 25), 25);
assert.equal(positiveNumber("0", 25), 25);
assert.equal(positiveNumber("1.5", 25), 1.5);
assert.equal(workspaceLayoutLabel({ name: "Workspaces Plus: Load: 研究" }), "研究");

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
  projectEnable: false
  , workMode: "cycle"
};
plugin.runtime = {
  phase: "idle",
  sessionCount: 0,
  cycleActive: false,
  cycleSlot: 0,
  strongAlert: false
};
plugin.ensureDayFreshness = () => {};
plugin.saveState = () => {};
plugin.broadcast = () => {};
plugin.applyTomatoAndSum = async amount => { plugin.written = amount; };
plugin.safeBumpProjectTomato = async () => {};
plugin.executedCommands = [];
plugin.app = {
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
plugin.startCycle();
assert.equal(plugin.runtime.currentTaskName, "简单任务");
assert.equal(plugin.runtime.tomatoCredit, 1.2);
assert.deepEqual(plugin.executedCommands, []);
assert.equal(plugin.selectCycleSlot(0), false);
plugin.runtime.startedAt = Date.now() - plugin.runtime.durationSec * 1000;

(async () => {
  await plugin.tick();
  assert.equal(plugin.written, 1.2);
  assert.equal(plugin.runtime.phase, "idle");
  assert.equal(plugin.runtime.pendingCycleSlot, 0);
  assert.equal(plugin.getLeftSec(), 900);

  plugin.onRibbonClick();
  assert.equal(plugin.runtime.currentTaskName, "难任务");
  assert.equal(plugin.runtime.durationSec, 900);
  assert.deepEqual(plugin.executedCommands, ["workspaces-plus:研究"]);
  console.log("cycle mode check passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
