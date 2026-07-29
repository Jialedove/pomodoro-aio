const assert = require("node:assert");
const fs = require("node:fs");
const Module = require("node:module");

assert.doesNotMatch(fs.readFileSync("src/main.js", "utf8"), /registerEvent\(this\.app\.workspace\.onLayoutReady/);
assert.match(fs.readFileSync("src/main.js", "utf8"), /clearTaskBtn\.onpointerdown/);
assert.match(fs.readFileSync("src/main.js", "utf8"), /clearProjBtn\.onpointerdown/);
assert.match(fs.readFileSync("src/main.js", "utf8"), /this\._unloading = true/);
assert.match(fs.readFileSync("styles.css", "utf8"), /pmd-datalist-opening .pmd-clear/);

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
Module._load = originalLoad;

const plugin = new PomodoroAIO();
plugin.settings = {
  cycleTaskA: "难任务",
  cycleMinA: 15,
  cycleTaskB: "简单任务",
  cycleMinB: 30,
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

plugin.startCycle();
assert.equal(plugin.runtime.currentTaskName, "难任务");
assert.equal(plugin.runtime.tomatoCredit, 0.6);
plugin.runtime.startedAt = Date.now() - plugin.runtime.durationSec * 1000;

(async () => {
  await plugin.tick();
  assert.equal(plugin.written, 0.6);
  assert.equal(plugin.runtime.phase, "idle");
  assert.equal(plugin.runtime.pendingCycleSlot, 1);
  assert.equal(plugin.getLeftSec(), 1800);

  plugin.onRibbonClick();
  assert.equal(plugin.runtime.currentTaskName, "简单任务");
  assert.equal(plugin.runtime.durationSec, 1800);
  console.log("cycle mode check passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
