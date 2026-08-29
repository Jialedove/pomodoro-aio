const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BreakBlackoutController,
  formatBlackoutTime,
  shouldShowBreakBlackout
} = require("../src/ui/break-blackout.js");

class FakeElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parent = null;
    this.className = "";
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

test("黑屏控制器支持倒计时、Esc 退出且同一休息不重新出现", () => {
  const document = new FakeDocument();
  let dismissCount = 0;
  const controller = new BreakBlackoutController({ document, onDismiss:()=> { dismissCount += 1; } });
  const runtime = breakRuntime();

  assert.equal(controller.sync(runtime, true, 299), true);
  assert.equal(document.body.children.length, 1);
  assert.equal(controller.timeEl.textContent, "04:59");
  let prevented = false;
  document.listeners.get("keydown")({ key:"Escape", preventDefault(){ prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(dismissCount, 1);
  assert.equal(document.body.children.length, 0);
  assert.equal(controller.sync(runtime, true, 298), false);
  assert.equal(controller.sync(breakRuntime({ status:"paused", startedAtMs:2000 }), true, 250), false);
  assert.equal(controller.sync(breakRuntime({ startedAtMs:3000 }), true, 249), false);

  controller.sync({ status:"awaiting", stage:null }, true, 0);
  assert.equal(controller.sync(breakRuntime({ startedAtMs:4000 }), true, 300), true);
  assert.equal(document.body.children.length, 1);
  controller.sync({ status:"idle", stage:null }, true, 0);
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.has("keydown"), false);
});

test("关闭设置和销毁控制器都会清理遮罩", () => {
  const document = new FakeDocument();
  const controller = new BreakBlackoutController({ document });
  controller.sync(breakRuntime(), true, 60);
  controller.sync(breakRuntime(), false, 59);
  assert.equal(document.body.children.length, 0);

  controller.sync(breakRuntime({ startedAtMs:3000 }), true, 58);
  controller.destroy();
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.has("keydown"), false);
});
