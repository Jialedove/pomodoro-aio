const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeClock, FakeVault, createPlugin } = require("./support.cjs");
const { PomodoroView } = require("../src/ui/pomodoro-view.js");

class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.text = options.text || "";
    this.value = "";
    this.children = [];
    this.attributes = { ...(options.attr || {}) };
    this.dataset = {};
    this.classes = new Set(String(options.cls || "").split(/\s+/).filter(Boolean));
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classes.has(name) : force;
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        return enabled;
      }
    };
  }
  empty() { this.children = []; this.text = ""; }
  addClass(name) { this.classes.add(name); }
  setText(text) { this.text = text; }
  set textContent(text) { this.text = text; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(" "); }
  set innerHTML(_html) {
    this.createEl("div", { cls:"pmd-ring-text" });
    this.createEl("circle", { cls:"pmd-ring-prog" });
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
  createEl(tag, options = {}) {
    const child = new Element(tag, options);
    this.appendChild(child);
    return child;
  }
  appendChild(child) {
    if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  addEventListener() {}
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(selector.startsWith(".") && child.classes.has(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
}

async function openView(plugin) {
  const originalWindow = global.window;
  global.window = { setTimeout:() => 0 };
  const listeners = new Map();
  plugin.app.workspace.on = (name, callback) => listeners.set(name, callback);
  plugin.app.workspace.off = name => listeners.delete(name);
  const view = new PomodoroView({}, plugin);
  view.app = plugin.app;
  view.containerEl = new Element();
  try { await view.onOpen(); }
  finally { global.window = originalWindow; }
  const button = view.containerEl.querySelectorAll(".pmd-btn").find(item => item.text === "完成事情");
  return { view, button };
}

function settings(modules) {
  return {
    modules, projectAssignments:{}, loopMode:"once", loopCount:1, autoAdvance:false,
    enableProjects:false, enableNotify:false, enableSound:false
  };
}

test("待确认工作完成按钮处理当前显示的最新事情", async () => {
  const clock = new FakeClock(1_000);
  const vault = new FakeVault({ "Daily/today.md":"- [ ] 阅读\n- [ ] 写作\n" });
  const plugin = createPlugin({ vault, settings:settings([
    { id:"rest", type:"rest", name:"休息", durationMin:5, blackout:false },
    { id:"work", type:"work", name:"阅读", durationMin:25, blackout:false }
  ]) });
  plugin._syncDeviceBridge = () => {};
  await clock.run(() => plugin.startSequence());
  await clock.run(() => plugin.completeCurrentModule());
  assert.equal(plugin.runtime.status, "awaiting");
  assert.equal(plugin.runtime.moduleRun, null);
  assert.equal(plugin.runtime.attention.moduleRun.name, "阅读");
  await plugin.updateModule("work", { name:"写作" });
  const { view, button } = await openView(plugin);
  assert.equal(button.classList.contains("pmd-hidden"), false);
  assert.equal(view.containerEl.querySelectorAll(".pmd-input").some(input => input.value === "写作"), true);
  let command;
  plugin.runUserCommand = action => { command = action(); };
  button.onclick();
  assert.ok(command, "可见的完成事情按钮应执行用户操作");
  await command;
  assert.equal(vault.getAbstractFileByPath("Daily/today.md").content, "- [ ] 阅读\n- [x] 写作\n");
  assert.equal(plugin.settings.modules[1].name, "工作");
  await view.onClose();
});

test("待确认休息不显示或执行完成事情操作", async () => {
  const clock = new FakeClock(2_000);
  const plugin = createPlugin({ settings:settings([
    { id:"work", type:"work", name:"阅读", durationMin:25, blackout:false },
    { id:"rest", type:"rest", name:"散步", durationMin:5, blackout:false }
  ]), vault:new FakeVault({ "Daily/today.md":"- [ ] 阅读\n" }) });
  plugin._syncDeviceBridge = () => {};
  await clock.run(() => plugin.startSequence());
  await clock.run(() => plugin.completeCurrentModule());
  assert.equal(plugin.runtime.status, "awaiting");
  const { view, button } = await openView(plugin);
  assert.equal(button.classList.contains("pmd-hidden"), true);
  let commands = 0;
  plugin.runUserCommand = () => { commands += 1; };
  button.onclick();
  assert.equal(commands, 0);
  await view.onClose();
});

test("普通任务页灯光选框常驻，与黑屏同一行并直接保存绑定", async () => {
  const plugin = createPlugin({ settings:settings([{ id:"work", type:"work", name:"阅读", durationMin:25, blackout:false }]) });
  const { view } = await openView(plugin);
  const selector = view.containerEl.querySelector(".pmd-lighting-select");
  const blackout = view.containerEl.querySelector(".pmd-module-blackout");
  assert.ok(selector, "无需进入设置模式就能选择灯光");
  assert.equal(selector.parent.parent, blackout.parent);
  assert.equal(selector.value, "inherit");
  let saved;
  plugin.runUserCommand = action => { saved = action(); };
  selector.value = "reading"; selector.onchange(); await saved;
  assert.equal(plugin.settings.modules[0].lightProgramId, "reading");
  await view.onClose();
});
