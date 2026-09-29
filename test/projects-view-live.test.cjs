const test = require("node:test");
const assert = require("node:assert/strict");
require("./support.cjs");
const { ProjectsView } = require("../src/ui/projects-view.js");

class Element {
  constructor(text = "") { this.value = ""; this.text = text; this.children = []; }
  empty() { this.children = []; this.text = ""; }
  addClass() {}
  setText(text) { this.text = text; this.children = []; }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
  createEl(_tag, options = {}) {
    const child = new Element(options.text || "");
    this.children.push(child);
    return child;
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(" "); }
}

function emitter() {
  const listeners = new Map();
  return {
    on(name, callback) { listeners.set(name, callback); },
    off(name) { listeners.delete(name); },
    trigger(name, payload) { listeners.get(name)?.(payload); }
  };
}

test("项目页先显示结算事件的数值，再由 metadata cache 校准", async () => {
  let cachedTomatoes = 1;
  const workspace = emitter();
  const metadataCache = emitter();
  const settings = { enableProjects:true, modules:[], projectAssignments:{} };
  const plugin = {
    settings,
    projectCandidates:() => [{ label:"项目", path:"Projects/X.md", tomatoes:cachedTomatoes }],
    snapshot:() => ({ settings })
  };
  const view = new ProjectsView({}, plugin);
  view.app = { workspace, metadataCache };
  view.containerEl = new Element();
  await view.onOpen();
  assert.match(view.containerEl.textContent, /1 🍅/);
  workspace.trigger("pomodoro:aio-project-updated", { path:"Projects/X.md", tomatoes:2 });
  assert.match(view.containerEl.textContent, /2 🍅/);
  assert.equal(view.liveTomatoes.get("Projects/X.md"), 2);
  metadataCache.trigger("changed", { path:"Projects/X.md" });
  assert.match(view.containerEl.textContent, /2 🍅/);
  assert.equal(view.liveTomatoes.get("Projects/X.md"), 2);
  cachedTomatoes = 2;
  metadataCache.trigger("changed", { path:"Projects/X.md" });
  assert.match(view.containerEl.textContent, /2 🍅/);
  assert.equal(view.liveTomatoes.has("Projects/X.md"), false);
  cachedTomatoes = 3;
  workspace.trigger("pomodoro:aio-project-updated", { path:"Projects/X.md", tomatoes:3 });
  assert.match(view.containerEl.textContent, /3 🍅/);
  assert.equal(view.liveTomatoes.has("Projects/X.md"), false);
  await view.onClose();
});
