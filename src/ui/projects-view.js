const { ItemView, Notice, setIcon } = require("obsidian");
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
    /** @type {Map<string, number>} */
    this.liveTomatoes = new Map();
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
    const backButton = heading.createEl("button", { cls: "pmd-btn pmd-icon-button pmd-projects-back", attr: { type: "button", "aria-label": "返回循环工作", title: "返回循环工作" } });
    setIcon(backButton, "timer");
    backButton.onclick = () => this.plugin.activateView({ leaf: this.leaf });
    const status = root.createDiv({ cls:"pmd-edit-status", attr:{ role:"status", "aria-live":"polite" } });
    const overview = root.createDiv({ cls:"pmd-project-overview" });
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
      overview.setText("");
      if (settings.enableProjects !== true) {
        content.createDiv({ cls: "pmd-empty", text: "推进中的项目已关闭。你可以在 Pomodoro AIO 设置中重新启用。" });
        return;
      }
      /** @type {ModuleDefinition[]} */
      const modules = (Array.isArray(settings.modules) ? settings.modules : []).filter((/** @type {ModuleDefinition} */ module) => module.type === "work");
      const assignments = settings.projectAssignments || {};
      const unassigned = modules.filter(module => !assignments[module.id]);
      overview.setText(`${this.projects.length} 个项目 · ${unassigned.length} 项工作待关联`);
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
        const folder = project.path.split("/").slice(0, -1).join("/");
        if (folder) titleGroup.createDiv({ cls: "pmd-project-path", text: folder });
        const headActions = cardHead.createDiv({ cls: "pmd-project-head-actions" });
        const sum = Number(project.tomatoes) || 0;
        headActions.createDiv({ cls: "pmd-project-tomatoes", text: `${sum.toFixed(sum % 1 ? 1 : 0)} 🍅` });
        const open = headActions.createEl("button", { cls: "pmd-btn pmd-icon-button", attr: { type: "button", "aria-label": `打开项目笔记：${project.path}`, title: "打开项目笔记" } });
        setIcon(open, "external-link");
        open.onclick = async () => {
          try { await this.plugin.openProject(project.path); }
          catch (error) { logViewError(this.plugin, "open-project", error); new Notice("无法打开项目笔记"); }
        };
        const section = card.createDiv({ cls: "pmd-project-work-list" });
        section.createEl("h4", { text: "关联工作" });
        if (!related.length) section.createDiv({ cls: "pmd-muted", text: "还没有关联工作。" });
        related.forEach(module => {
          const row = section.createDiv({ cls: "pmd-project-work-row" });
          row.createSpan({ cls: "pmd-project-work-name", text: module.name || "未命名工作" });
          const unlink = row.createEl("button", { cls: "pmd-btn pmd-icon-button pmd-project-unlink", attr: { type: "button", "aria-label": `解除 ${module.name || "未命名工作"} 与此项目的关联`, title: "解除关联" } });
          setIcon(unlink, "unlink");
          unlink.onclick = () => edit(() => this.plugin.setModuleProject(module.id, ""), "关联已解除");
        });
        if (unassigned.length) {
          const addRow = card.createDiv({ cls: "pmd-project-add-row" });
          const select = addRow.createEl("select", { cls: "pmd-input", attr: { "aria-label": `选择关联到 ${project.path} 的工作` } });
          select.createEl("option", { text: "选择一项工作…", attr: { value: "" } });
          unassigned.forEach(module => select.createEl("option", { text: module.name || "未命名工作", attr: { value: module.id } }));
          const assign = addRow.createEl("button", { cls: "pmd-btn pmd-icon-button", attr: { type: "button", "aria-label": "关联选中的工作", title: "关联选中的工作" } });
          setIcon(assign, "plus");
          assign.disabled = true;
          select.onchange = () => { assign.disabled = !select.value; };
          assign.onclick = () => {
            if (!select.value) return;
            edit(() => this.plugin.setModuleProject(select.value, project.path), "工作已关联到项目");
          };
        }
      });
    };

    const refreshProjects = () => {
      if (this.plugin.settings.enableProjects !== true) { this.projects = []; return; }
      try {
        this.projects = this.plugin.projectCandidates().map((/** @type {ProjectOption} */ project) => ({
          ...project,
          tomatoes:this.liveTomatoes.get(project.path) ?? project.tomatoes
        }));
      }
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
    const onProjectUpdated = (/** @type {{path?:string, tomatoes?:number}} */ update) => {
      if (!update?.path || !Number.isFinite(update.tomatoes)) return;
      const cached = this.plugin.projectCandidates().find((/** @type {ProjectOption} */ project) => project.path === update.path);
      if (cached && Number(cached.tomatoes) === Number(update.tomatoes)) this.liveTomatoes.delete(update.path);
      else this.liveTomatoes.set(update.path, Number(update.tomatoes));
      refreshProjects();
      render(this.plugin.snapshot());
    };
    this.app.workspace.on("pomodoro:aio-project-updated", onProjectUpdated);
    this.disposers.push(() => this.app.workspace.off("pomodoro:aio-project-updated", onProjectUpdated));
    const onMetadataChanged = (/** @type {{path?:string}} */ file) => {
      if (!file?.path || !this.liveTomatoes.has(file.path)) return;
      const cached = this.plugin.projectCandidates().find((/** @type {ProjectOption} */ project) => project.path === file.path);
      if (!cached || Number(cached.tomatoes) !== this.liveTomatoes.get(file.path)) return;
      this.liveTomatoes.delete(file.path);
      refreshProjects();
      render(this.plugin.snapshot());
    };
    this.app.metadataCache.on("changed", onMetadataChanged);
    this.disposers.push(() => this.app.metadataCache.off("changed", onMetadataChanged));
  }

  async onClose() {
    this.disposers.forEach(dispose => { try { dispose(); } catch (error) { logViewError(this.plugin, "view-lifecycle", error); } });
    this.disposers.length = 0;
  }
}

module.exports = { ProjectsView };
