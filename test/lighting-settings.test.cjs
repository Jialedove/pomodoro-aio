const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { LIGHT_PROGRAM_TEMPLATES } = require("../src/core/lighting-presets.js");
const { DEFAULT_LIGHT_PROGRAMS } = require("../src/core/lighting.js");

class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag; this.text = options.text || ""; this.value = ""; this.disabled = false;
    this.children = []; this.parent = null; this.style = {};
    this.attributes = { ...(options.attr || {}) };
    this.className = String(options.cls || "");
  }
  get classes() { return this.className.split(/\s+/).filter(Boolean); }
  empty() { this.children = []; this.text = ""; }
  addClass(name) { this.className += ` ${name}`; }
  setText(text) { this.text = text; }
  setAttribute(name, value) { this.attributes[name] = value; }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
  createEl(tag, options = {}) { const child = new Element(tag, options); child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
  querySelector(selector) { return this.all().slice(1).find(element => element.classes.includes(selector.slice(1))) || null; }
  textAll() { return this.all().map(element => element.text).filter(Boolean).join("\n"); }
}
const byText = (root, text) => root.all().find(element => element.tag === "button" && element.text === text);
const byClass = (root, cls) => root.all().filter(element => element.classes.includes(cls));
const flush = () => new Promise(resolve => { setImmediate(resolve); });

function loadSettingsModule() {
  const originalLoad = Module._load;
  class Setting {
    constructor(container) { this.el = container.createDiv({ cls:"setting-item" }); }
    setName(name) { this.el.createDiv({ cls:"setting-item-name", text:name }); return this; }
    setDesc(text) { this.el.createDiv({ text }); return this; }
    addToggle(callback) { callback({ setValue() { return this; }, onChange() { return this; } }); return this; }
    addDropdown(callback) {
      const select = this.el.createEl("select");
      const component = { addOptions:options => { select.options = options; return component; }, setValue:value => { select.value = value; return component; }, onChange:() => component };
      callback(component); return this;
    }
  }
  Module._load = (request, parent, isMain) => request === "obsidian" ? { Setting } : originalLoad(request, parent, isMain);
  try {
    delete require.cache[require.resolve("../src/ui/lighting-settings.js")];
    return require("../src/ui/lighting-settings.js");
  } finally { Module._load = originalLoad; }
}

function createPlugin() {
  const saved = [];
  const plugin = {
    settings:{ lightingPrograms:DEFAULT_LIGHT_PROGRAMS.map(program => JSON.parse(JSON.stringify(program))), modules:[{ id:"m1", lightProgramId:"reading" }],
      lightingDefaultWorkId:"work", lightingDefaultRestId:"rest", lightingBaseUrl:"http://127.0.0.1:18473" },
    saved,
    bridge:{ devices:[{ id:"lamp", name:"台灯", observedState:{ isOnline:true }, capabilities:{ brightnessRange:[1, 100], colorTempKelvinRange:[2700, 6500] } }], stopPreview:async () => {} },
    _getDeviceBridge() { return this.bridge; },
    async saveLightProgram(program) {
      saved.push(program);
      const next = { ...program, revision:program.revision + 1 };
      this.settings.lightingPrograms = [...this.settings.lightingPrograms.filter(item => item.id !== program.id), next];
      return next;
    },
    async refreshLightingLibrary() { return { programs:this.settings.lightingPrograms, devices:this.bridge.devices }; }
  };
  return plugin;
}

test("灯光设置按连接、默认、我的方案、常用方案分组并显示可读摘要", () => {
  const { renderLightingSettings } = loadSettingsModule();
  const root = new Element();
  const plugin = createPlugin();
  renderLightingSettings(root, plugin, async () => true);
  const headings = root.all().filter(element => element.tag === "h4").map(element => element.text);
  assert.deepEqual(headings, ["连接与灯具", "默认方案", "我的方案", "常用方案"]);
  const text = root.textAll();
  assert.match(text, /开始时：开灯 亮度 80% · 4600K/);
  assert.match(text, /默认工作/);
  assert.match(text, /1 个任务使用/);
  assert.match(text, /已读取灯具/);
  assert.equal(byClass(root, "pmd-light-template").length, LIGHT_PROGRAM_TEMPLATES.length);
});

test("添加常用方案写入方案库后显示已添加，全部添加跳过已有方案", async () => {
  const { renderLightingSettings } = loadSettingsModule();
  const root = new Element();
  const plugin = createPlugin();
  renderLightingSettings(root, plugin, async () => true);
  byText(root, "添加到我的方案").onclick();
  await flush();
  assert.equal(plugin.saved.length, 1);
  assert.equal(plugin.saved[0].id, LIGHT_PROGRAM_TEMPLATES[0].program.id);
  assert.equal(plugin.saved[0].revision, 1);
  assert.match(root.textAll(), /✓ 已在我的方案/);
  byText(root, `全部添加（${LIGHT_PROGRAM_TEMPLATES.length - 1} 个）`).onclick();
  await flush(); await flush();
  assert.equal(plugin.saved.length, LIGHT_PROGRAM_TEMPLATES.length);
  assert.equal(new Set(plugin.saved.map(program => program.id)).size, LIGHT_PROGRAM_TEMPLATES.length);
  assert.equal(root.querySelector(".pmd-light-templates-all"), null);
});

test("编辑方案时步骤标题随输入更新，未保存时不能切换编辑其他方案", async () => {
  const { renderLightingSettings } = loadSettingsModule();
  const root = new Element();
  const plugin = createPlugin();
  renderLightingSettings(root, plugin, async () => true);
  root.all().find(element => element.attributes["aria-label"] === "编辑方案「工作模式」").onclick();
  await flush();
  const brightness = root.all().find(element => element.tag === "input" && element.attributes.max === "100" && element.value === "80");
  brightness.value = "55"; brightness.oninput();
  assert.match(root.textAll(), /开始时：开灯 亮度 55% · 4600K/);
  const deleteBase = root.all().find(element => element.attributes["aria-label"] === "删除步骤 1");
  assert.equal(deleteBase.disabled, true);
  root.all().find(element => element.attributes["aria-label"] === "编辑方案「阅读模式」").onclick();
  await flush();
  assert.match(root.textAll(), /请先保存或取消当前方案的修改/);
  byText(root, "保存方案").onclick();
  await flush();
  assert.equal(plugin.saved.at(-1).steps[0].target.brightnessPct, 55);
  assert.equal(byClass(root, "pmd-light-program-editor").length, 0);
});
