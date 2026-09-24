const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { NativeBlackoutController } = require("../src/ui/native-blackout.js");

class FakeElement {
  constructor() {
    this.children = [];
    this.className = "";
    this.classList = { add: name => { this.className += ` ${name}`; } };
    this.attributes = {};
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
}

function fakeDocument() {
  const listeners = new Map();
  return {
    body:new FakeElement(),
    createElement:() => new FakeElement(),
    addEventListener:(name, listener) => listeners.set(name, listener),
    removeEventListener:(name) => listeners.delete(name)
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.messages = [];
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.write = line => { child.messages.push(JSON.parse(line)); return true; };
  child.stdin.end = () => { child.stdin.writable = false; };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.exitCode = 0; };
  return child;
}

const runtime = (overrides={}) => ({
  status:"running", stage:"focus", mode:"standard", sessionId:"focus-1",
  currentTaskName:"写研究提纲", leftMs:90_000, ...overrides
});

test("原生遮罩只发送任务文字和计时，不创建 Obsidian 全屏页面", () => {
  const document = fakeDocument();
  const children = [];
  const controller = new NativeBlackoutController({
    document, binaryPath:"/tmp/blackout", spawnProcess:() => {
      const child = fakeChild();
      children.push(child);
      return child;
    }
  });
  assert.equal(controller.sync(runtime(), { taskBlackoutEnabled:true }, 90), true);
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].messages[0], {
    type:"show", label:"现在应该做什么", title:"写研究提纲", leftMs:90_000, paused:false
  });
  assert.equal(document.body.children.length, 0);

  controller.sync(runtime({ status:"paused", leftMs:85_500 }), { taskBlackoutEnabled:true }, 86);
  assert.equal(children[0].messages.at(-1).paused, true);
  assert.equal(children[0].messages.at(-1).leftMs, 85_500);

  children[0].stdout.emit("data", Buffer.from('{"type":"dismissed"}\n'));
  assert.equal(controller.sync(runtime(), { taskBlackoutEnabled:true }, 85), false);
  assert.equal(children.length, 1);
  controller.sync({ status:"idle", stage:null }, { taskBlackoutEnabled:true }, 0);
  assert.equal(controller.sync(runtime({ sessionId:"focus-2" }), { taskBlackoutEnabled:true }, 90), true);
  assert.equal(children.length, 2);
  controller.destroy();
});

test("原生程序失败时退回窗口内遮罩，且该阶段不反复启动", () => {
  const document = fakeDocument();
  const children = [];
  const notices = [];
  const controller = new NativeBlackoutController({
    document, binaryPath:"/tmp/blackout", onUnavailable:reason => notices.push(reason),
    spawnProcess:() => { const child = fakeChild(); children.push(child); return child; }
  });
  controller.sync(runtime(), { taskBlackoutEnabled:true }, 90);
  children[0].emit("error", new Error("not executable"));
  assert.equal(notices.length, 1);
  assert.equal(document.body.children.length, 1);
  controller.sync(runtime(), { taskBlackoutEnabled:true }, 89);
  assert.equal(children.length, 1);
  controller.sync({ status:"idle", stage:null }, { taskBlackoutEnabled:true }, 0);
  assert.equal(document.body.children.length, 0);
  controller.destroy();
});

test("结束闪烁窗口期后正常结算；过期子进程消息不能结束新遮罩", () => {
  let now = 1000;
  const children = [];
  const controller = new NativeBlackoutController({
    document:fakeDocument(), binaryPath:"/tmp/blackout", now:() => now,
    spawnProcess:() => { const child = fakeChild(); children.push(child); return child; }
  });
  controller.sync(runtime({ leftMs:0 }), { taskBlackoutEnabled:true }, 0);
  assert.equal(controller.isFinishing(), true);
  now += 320;
  assert.equal(controller.isFinishing(), false);
  controller.sync(runtime({ sessionId:"focus-2" }), { taskBlackoutEnabled:true }, 90);
  children[0].stdout.emit("data", Buffer.from('{"type":"dismissed"}\n'));
  assert.equal(controller.sync(runtime({ sessionId:"focus-2" }), { taskBlackoutEnabled:true }, 89), true);
  controller.destroy();
});
