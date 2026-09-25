const { ItemView, Notice } = require("obsidian");
/** @typedef {{id:string, type:"work"|"rest", name:string, durationMin:number, blackout:boolean, workspaceCommandId?:string}} ModuleDefinition */
/** @typedef {{label:string, path:string, tomatoes?:number}} ProjectOption */

/** @param {any} plugin @param {string} operation @param {unknown} error */
function logViewError(plugin, operation, error) {
  console.error("Pomodoro AIO 项目视图操作失败", {
    operation,
    sessionId: plugin?.runtime?.sessionId || null,
    step: "ui",
    error: String(error instanceof Error ? error.message : error || "unknown error")
  });
}

class ProjectsView extends ItemView {
  static VIEW_TYPE = "pomodoro-aio-projects-view";
  /** @param {any} leaf @param {any} plugin */
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    /** @type {Array<() => void>} */
    this.disposers = [];
    /** @type {ProjectOption[]} */
    this.projects = [];
    this._renderSignature = "";
  }
  getViewType() { return ProjectsView.VIEW_TYPE; }
  getDisplayText() { return "推进中的项目"; }
  getIcon() { return "folder-kanban"; }

  async onOpen() {
    const root = this.containerEl;
    root.empty();
    root.addClass("pmd-root");
    root.addClass("pmd-projects-root");
    const heading = root.createDiv({ cls: "pmd-view-heading" });
    heading.createEl("h2", { text: "推进中的项目" });
    const backButton = heading.createEl("button", { cls: "pmd-btn pmd-btn-secondary", text: "循环工作", attr: { type: "button" } });
    backButton.onclick = () => this.plugin.activateView();
    const status = root.createDiv({ cls:"pmd-edit-status", attr:{ role:"status", "aria-live":"polite" } });
    const content = root.createDiv({ cls: "pmd-project-list" });
    /** @param {()=>Promise<any>} action @param {string} success */
    const edit = async (action, success) => {
      try {
        const result = await action();
        if (result === false) throw new Error("project edit rejected");
        status.setText(success);
      } catch (error) {
        status.setText("项目关系保存失败");
        logViewError(this.plugin, "project-edit", error);
      }
    };

    /** @param {any} snap */
    const render = snap => {
      const settings = snap.settings || this.plugin.settings;
      const signature = JSON.stringify([
        settings.enableProjects, settings.modules, settings.projectAssignments, this.projects
      ]);
      if (signature === this._renderSignature) return;
      this._renderSignature = signature;
      content.empty();
      if (settings.enableProjects !== true) {
        content.createDiv({ cls: "pmd-empty", text: "推进中的项目已关闭。你可以在 Pomodoro AIO 设置中重新启用。" });
        return;
      }
      /** @type {ModuleDefinition[]} */
      const modules = (Array.isArray(settings.modules) ? settings.modules : []).filter((/** @type {ModuleDefinition} */ module) => module.type === "work");
      const assignments = settings.projectAssignments || {};
      if (!this.projects.length) {
        content.createDiv({ cls: "pmd-empty", text: "没有符合项目标签和状态条件的笔记。" });
        return;
      }
      this.projects.forEach(project => {
        const related = modules.filter(module => assignments[module.id] === project.path);
        const card = content.createDiv({ cls: "pmd-project-card" });
        const cardHead = card.createDiv({ cls: "pmd-project-card-head" });
        const titleGroup = cardHead.createDiv({ cls: "pmd-project-title-group" });
        titleGroup.createEl("h3", { text: (project.path.split("/").pop() || project.path).replace(/\.md$/i, "") });
        titleGroup.createDiv({ cls: "pmd-project-path", text: project.path });
        const sum = Number(project.tomatoes) || 0;
        cardHead.createDiv({ cls: "pmd-project-tomatoes", text: `${sum.toFixed(sum % 1 ? 1 : 0)} 🍅` });
        const section = card.createDiv({ cls: "pmd-project-work-list" });
        section.createEl("h4", { text: "关联工作" });
        if (!related.length) section.createDiv({ cls: "pmd-muted", text: "还没有关联工作。" });
        related.forEach(module => {
          const row = section.createDiv({ cls: "pmd-project-work-row" });
          row.createSpan({ cls: "pmd-project-work-name", text: module.name || "未命名工作" });
          const unlink = row.createEl("button", { cls: "pmd-btn pmd-btn-tertiary", text: "解除关联", attr: { type: "button", "aria-label": `解除 ${module.name || "未命名工作"} 与此项目的关联` } });
          unlink.onclick = () => edit(() => this.plugin.setModuleProject(module.id, ""), "关联已解除");
        });
        const addRow = card.createDiv({ cls: "pmd-project-add-row" });
        const available = modules.filter(module => !assignments[module.id] || assignments[module.id] === project.path);
        const select = addRow.createEl("select", { cls: "pmd-input", attr: { "aria-label": `选择关联到 ${project.path} 的工作` } });
        select.createEl("option", { text: "选择一项工作…", attr: { value: "" } });
        available.filter(module => assignments[module.id] !== project.path).forEach(module => select.createEl("option", { text: module.name || "未命名工作", attr: { value: module.id } }));
        const assign = addRow.createEl("button", { cls: "pmd-btn", text: "关联工作", attr: { type: "button" } });
        assign.disabled = available.filter(module => assignments[module.id] !== project.path).length === 0;
        assign.onclick = () => {
          if (!select.value) return;
          edit(() => this.plugin.setModuleProject(select.value, project.path), "工作已关联到项目");
        };
        const open = card.createEl("button", { cls: "pmd-btn pmd-btn-primary", text: "打开项目笔记", attr: { type: "button" } });
        open.onclick = async () => {
          try { await this.plugin.openProject(project.path); }
          catch (error) { logViewError(this.plugin, "open-project", error); new Notice("无法打开项目笔记"); }
        };
      });
      const unassigned = modules.filter(module => !assignments[module.id]);
      if (unassigned.length && this.projects.length) {
        const hint = content.createDiv({ cls: "pmd-unassigned-hint" });
        hint.setText(`${unassigned.length} 项工作尚未关联项目；可在上方项目卡片中选择关联。`);
      }
    };

    const refreshProjects = () => {
      if (this.plugin.settings.enableProjects !== true) { this.projects = []; return; }
      try { this.projects = this.plugin.projectCandidates(); }
      catch (error) { this.projects = []; logViewError(this.plugin, "project-refresh", error); }
    };
    refreshProjects();
    render(this.plugin.snapshot());
    /** @param {any} snap */
    const onState = snap => {
      if (snap.settings?.enableProjects === true) refreshProjects();
      render(snap);
    };
    this.app.workspace.on("pomodoro:aio-state", onState);
    this.disposers.push(() => this.app.workspace.off("pomodoro:aio-state", onState));
  }

  async onClose() {
    this.disposers.forEach(dispose => { try { dispose(); } catch (error) { logViewError(this.plugin, "view-lifecycle", error); } });
    this.disposers.length = 0;
  }
}

module.exports = { ProjectsView };
