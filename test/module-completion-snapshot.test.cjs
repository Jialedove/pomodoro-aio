const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeClock, FakeVault, createPlugin } = require("./support.cjs");

for (const external of [false, true]) {
  test(`${external ? "日记外部勾选" : "完成事情"}保留运行中改为另一事情的后续模块配置`, async () => {
    const clock = new FakeClock(10_000);
    const vault = new FakeVault({ "Daily/today.md":"- [ ] 阅读 0🍅\n- [ ] 写作 0🍅\n" });
    const plugin = createPlugin({ vault, settings:{
      modules:[{ id:"work-reading", type:"work", name:"阅读", durationMin:25, blackout:false }],
      restPresets:[], projectAssignments:{}, loopMode:"infinite", loopCount:1, autoAdvance:false,
      enableProjects:false, enableNotify:false, enableSound:false
    } });
    await clock.run(() => plugin.startSequence());
    await plugin.updateModule("work-reading", { name:"写作", workspaceCommandId:"layout-writing", blackout:true });
    await plugin.setModuleProject("work-reading", "Projects/Writing.md");
    clock.advance(10 * 60_000);
    if (external) {
      vault.getAbstractFileByPath("Daily/today.md").content = "- [x] 阅读 0🍅\n- [ ] 写作 0🍅\n";
      await clock.run(() => plugin.syncCompletedTaskSelections());
    } else {
      assert.equal(await clock.run(() => plugin.completeTask({ moduleId:"work-reading" })), true);
    }
    assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /- \[x\] 阅读 0\.4🍅/);
    assert.match(vault.getAbstractFileByPath("Daily/today.md").content, /- \[ \] 写作 0🍅/);
    assert.equal(plugin.settings.modules[0].name, "写作");
    assert.equal(plugin.settings.modules[0].workspaceCommandId, "layout-writing");
    assert.equal(plugin.settings.modules[0].blackout, true);
    assert.equal(plugin.settings.projectAssignments["work-reading"], "Projects/Writing.md");
    await clock.run(() => plugin.startPendingStage());
    assert.equal(plugin.runtime.moduleRun.name, "写作");
    assert.equal(plugin.runtime.moduleRun.workspaceCommandId, "layout-writing");
  });
}
