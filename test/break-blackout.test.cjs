const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BreakBlackoutController,
  formatBlackoutTime,
  blackoutPrompt,
  shouldShowBreakBlackout,
  shouldShowBlackout,
  getBlackoutCapability
} = require("../src/ui/break-blackout.js");

class FakeElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parent = null;
    this.className = "";
    this.classList = { add: name => { this.className = `${this.className} ${name}`.trim(); } };
    this.textContent = "";
    this.attributes = {};
    this.onclick = null;
  }

  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.body = new FakeElement("body", this);
    this.documentElement = new FakeElement("html", this);
    this.exitFullscreen = null;
  }

  createElement(tag) { return new FakeElement(tag, this); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeEventListener(type, callback) {
    if (this.listeners.get(type) === callback) this.listeners.delete(type);
  }
}

function breakRuntime(overrides = {}) {
  return {
    status:"running",
    stage:"break",
    mode:"standard",
    startedAtMs:1000,
    durationMs:300000,
    ...overrides
  };
}

test("黑屏只在已开始或暂停的休息阶段显示", () => {
  assert.equal(shouldShowBreakBlackout(breakRuntime(), true), true);
  assert.equal(shouldShowBreakBlackout(breakRuntime({ status:"paused" }), true), true);
  assert.equal(shouldShowBreakBlackout(breakRuntime({ status:"awaiting", stage:null }), true), false);
  assert.equal(shouldShowBreakBlackout(breakRuntime({ stage:"focus" }), true), false);
  assert.equal(shouldShowBreakBlackout(breakRuntime(), false), false);
  assert.equal(formatBlackoutTime(301), "05:01");
});

test("专注黑屏按普通任务和循环任务的独立开关显示", () => {
  assert.equal(shouldShowBlackout(breakRuntime({ stage:"focus", mode:"standard" }), { taskBlackoutEnabled:true }), true);
  assert.equal(shouldShowBlackout(breakRuntime({ stage:"focus", mode:"standard" }), { taskBlackoutEnabled:false }), false);
  assert.equal(shouldShowBlackout(breakRuntime({ stage:"focus", mode:"cycle", cycleSlot:0 }), { cycleTaskBlackoutA:true }), true);
  assert.equal(shouldShowBlackout(breakRuntime({ stage:"focus", mode:"cycle", cycleSlot:1 }), { cycleTaskBlackoutB:true }), true);
  assert.equal(shouldShowBlackout(breakRuntime({ stage:"focus", mode:"cycle", cycleSlot:1 }), { cycleTaskBlackoutA:true }), false);
});

test("黑屏显示当前任务名，而不是固定的离开电脑提示", () => {
  const document = new FakeDocument();
  const controller = new BreakBlackoutController({ document });
  const standard = breakRuntime({ stage:"focus", currentTaskName:"写研究提纲", sessionId:"focus-1" });
  assert.deepEqual(blackoutPrompt(standard, {}), { label:"现在应该做什么", title:"写研究提纲" });
  controller.sync(standard, { taskBlackoutEnabled:true }, 90);
  assert.equal(controller.labelEl.textContent, "现在应该做什么");
  assert.equal(controller.titleEl.textContent, "写研究提纲");
  controller.sync(breakRuntime({ stage:"focus", mode:"cycle", cycleSlot:1, currentTaskName:"", sessionId:"focus-2" }), { cycleTaskBlackoutB:true, cycleTaskB:"阅读材料" }, 80);
  assert.equal(controller.titleEl.textContent, "阅读材料");
  controller.sync(breakRuntime(), { breakBlackoutEnabled:true }, 60);
  assert.equal(controller.titleEl.textContent, "休息一下");
});

test("结束倒计时只闪烁一次，窗口后备遮罩不请求网页全屏", () => {
  const document = new FakeDocument();
  let fullscreenRequests = 0;
  let now = 1_000;
  document.documentElement.requestFullscreen = () => {
    fullscreenRequests += 1;
  };
  const controller = new BreakBlackoutController({ document, now:()=>now, finishDurationMs:320 });
  const runtime = breakRuntime({ sessionId:"break-1" });

  assert.equal(getBlackoutCapability(document).canCoverOtherApps, false);
  assert.equal(getBlackoutCapability(document).canRequestCurrentDisplayFullscreen, false);
  controller.sync(runtime, { breakBlackoutEnabled:true }, 0);
  assert.equal(fullscreenRequests, 0);
  assert.match(controller.overlay.className, /pmd-blackout-finished/);
  assert.equal(controller.isFinishing(), true);
  now += 320;
  assert.equal(controller.isFinishing(), false);
  const className = controller.overlay.className;
  controller.sync(runtime, { breakBlackoutEnabled:true }, 0);
  assert.equal(controller.overlay.className, className);
});

test("黑屏控制器支持倒计时、Esc 退出且同一休息不重新出现", () => {
  const document = new FakeDocument();
  let dismissCount = 0;
  const controller = new BreakBlackoutController({ document, onDismiss:()=> { dismissCount += 1; } });
  const runtime = breakRuntime();

  assert.equal(controller.sync(runtime, { breakBlackoutEnabled:true }, 299), true);
  assert.equal(document.body.children.length, 1);
  assert.equal(controller.timeEl.textContent, "04:59");
  let prevented = false;
  document.listeners.get("keydown")({ key:"Escape", preventDefault(){ prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(dismissCount, 1);
  assert.equal(document.body.children.length, 0);
  assert.equal(controller.sync(runtime, { breakBlackoutEnabled:true }, 298), false);
  assert.equal(controller.sync(breakRuntime({ status:"paused", startedAtMs:2000 }), { breakBlackoutEnabled:true }, 250), false);
  assert.equal(controller.sync(breakRuntime({ startedAtMs:3000 }), { breakBlackoutEnabled:true }, 249), false);

  controller.sync({ status:"awaiting", stage:null }, { breakBlackoutEnabled:true }, 0);
  assert.equal(controller.sync(breakRuntime({ startedAtMs:4000 }), { breakBlackoutEnabled:true }, 300), true);
  assert.equal(document.body.children.length, 1);
  controller.sync({ status:"idle", stage:null }, { breakBlackoutEnabled:true }, 0);
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.has("keydown"), false);
});

test("关闭设置和销毁控制器都会清理遮罩", () => {
  const document = new FakeDocument();
  const controller = new BreakBlackoutController({ document });
  controller.sync(breakRuntime(), { breakBlackoutEnabled:true }, 60);
  controller.sync(breakRuntime(), { breakBlackoutEnabled:false }, 59);
  assert.equal(document.body.children.length, 0);

  controller.sync(breakRuntime({ startedAtMs:3000 }), { breakBlackoutEnabled:true }, 58);
  controller.destroy();
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.has("keydown"), false);
});
