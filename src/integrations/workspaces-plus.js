const WORKSPACES_PLUS_PREFIX = "workspaces-plus:";
const LOAD_COMMAND_RE = /(?:^|:\s)Load:\s/;

function workspaceLayoutLabel(command) {
  return String(command?.name || "").replace(/^.*?Load:\s*/, "");
}

class WorkspacesPlusAdapter {
  constructor(app) {
    this.app = app || {};
  }

  getLayoutCommands() {
    try {
      return (this.app.commands?.listCommands?.() || [])
        .filter(command => command?.id?.startsWith(WORKSPACES_PLUS_PREFIX) && LOAD_COMMAND_RE.test(String(command.name || "")))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
    } catch (error) {
      console.warn("Pomodoro AIO Workspaces Plus 命令读取失败", String(error?.message || error));
      return [];
    }
  }

  layoutLabel(command) {
    return workspaceLayoutLabel(command);
  }

  isLayoutActive(commandId) {
    try {
      const id = String(commandId || "");
      if (!this.getLayoutCommands().some(command => command.id === id)) return false;
      const activeWorkspace = this.app.internalPlugins?.getPluginById?.("workspaces")?.instance?.activeWorkspace;
      return activeWorkspace === id.slice(WORKSPACES_PLUS_PREFIX.length);
    } catch (error) {
      console.warn("Pomodoro AIO Workspaces Plus 布局状态读取失败", String(error?.message || error));
      return false;
    }
  }
}

module.exports = { WorkspacesPlusAdapter, workspaceLayoutLabel };
