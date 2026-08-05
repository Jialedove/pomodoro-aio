const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WorkspacesPlusAdapter,
  workspaceLayoutLabel
} = require("../src/integrations/workspaces-plus.js");

function createAdapter(activeWorkspace = "整理") {
  return new WorkspacesPlusAdapter({
    commands: {
      listCommands: () => [
        { id: "workspaces-plus:研究", name: "Workspaces Plus: Load: 研究" },
        { id: "workspaces-plus:整理", name: "Workspaces Plus: Load: 整理" },
        { id: "workspaces-plus:open", name: "Open Workspaces Plus" },
        { id: "other:load", name: "Load: 其他" }
      ]
    },
    internalPlugins: {
      getPluginById: id => id === "workspaces" ? { instance: { activeWorkspace } } : null
    }
  });
}

test("Workspaces Plus 适配器只暴露 Load 布局命令并保持排序", () => {
  const adapter = createAdapter();
  assert.deepEqual(
    adapter.getLayoutCommands().map(command => command.id),
    ["workspaces-plus:研究", "workspaces-plus:整理"]
  );
  assert.equal(workspaceLayoutLabel({ name: "Workspaces Plus: Load: 研究" }), "研究");
  assert.equal(adapter.layoutLabel({ name: "Workspaces Plus: Load: 整理" }), "整理");
});

test("Workspaces Plus 适配器判断当前布局，缺少接口时安全返回", () => {
  const adapter = createAdapter("整理");
  assert.equal(adapter.isLayoutActive("workspaces-plus:整理"), true);
  assert.equal(adapter.isLayoutActive("workspaces-plus:研究"), false);
  assert.equal(new WorkspacesPlusAdapter({}).getLayoutCommands().length, 0);
  assert.equal(new WorkspacesPlusAdapter({}).isLayoutActive("workspaces-plus:研究"), false);
});

test("Workspaces Plus 私有接口异常时不向计时流程抛错", () => {
  const adapter = new WorkspacesPlusAdapter({
    commands: { listCommands: () => { throw new Error("插件未加载"); } },
    internalPlugins: { getPluginById: () => { throw new Error("工作区接口不可用"); } }
  });
  assert.deepEqual(adapter.getLayoutCommands(), []);
  assert.equal(adapter.isLayoutActive("workspaces-plus:研究"), false);
});
