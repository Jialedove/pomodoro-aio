const test = require("node:test");
const assert = require("node:assert/strict");
const { createBackgroundTimers } = require("../src/services/background-timers.js");

test("后台计时优先使用 Node 计时器，不依赖窗口定时器", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setTimeout:() => { throw new Error("window timer used"); },
    setInterval:() => { throw new Error("window timer used"); }
  };
  try {
    const timers = createBackgroundTimers();
    await new Promise(resolve => { timers.setTimeout(resolve, 1); });
    let count = 0;
    await new Promise(resolve => {
      const handle = timers.setInterval(() => {
        count += 1;
        if (count === 2) { timers.clearInterval(handle); resolve(); }
      }, 1);
    });
    assert.equal(count, 2);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("Node 计时器不可用时退回窗口定时器", () => {
  const calls = [];
  const previousWindow = globalThis.window;
  globalThis.window = {
    setTimeout:(_callback, delay) => { calls.push(["timeout", delay]); return 7; },
    clearTimeout:handle => calls.push(["clear", handle]),
    setInterval:(_callback, delay) => { calls.push(["interval", delay]); return 8; },
    clearInterval:handle => calls.push(["clearInterval", handle])
  };
  try {
    const timers = createBackgroundTimers(() => { throw new Error("no node"); });
    timers.clearTimeout(timers.setTimeout(() => {}, 1000));
    timers.clearInterval(timers.setInterval(() => {}, 2000));
    assert.deepEqual(calls, [["timeout", 1000], ["clear", 7], ["interval", 2000], ["clearInterval", 8]]);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
