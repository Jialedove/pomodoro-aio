const test = require("node:test");
const assert = require("node:assert/strict");
const { RuntimeStore } = require("../src/services/runtime-store.js");

test("runtime-store 在入队时复制快照并按顺序写入", async () => {
  const saves = [];
  const delays = [20, 0];
  const store = new RuntimeStore({
    readRuntime: async () => null,
    writeRuntime: async value => {
      const delay = delays.shift() || 0;
      if (delay) await new Promise(resolve => { setTimeout(resolve, delay); });
      saves.push(value);
    },
    readSettings: async () => ({}),
    writeSettings: async () => {}
  });

  const runtime = { sessionCount: 1 };
  const first = store.saveRuntime(runtime);
  runtime.sessionCount = 2;
  const second = store.saveRuntime(runtime);
  await Promise.all([first, second]);

  assert.deepEqual(saves.map(value => value.sessionCount), [1, 2]);
});

test("runtime-store 的 critical 保存传播错误，普通保存继续队列", async () => {
  const errors = [];
  const contexts = [];
  let attempt = 0;
  const store = new RuntimeStore({
    readRuntime: async () => null,
    writeRuntime: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("disk full");
    },
    readSettings: async () => ({}),
    writeSettings: async () => {},
    onError: (error, context) => {
      errors.push(error.message);
      contexts.push(context);
    }
  });

  await assert.rejects(() => store.saveRuntime({ attempt: 1 }, { critical: true }), /disk full/);
  await store.saveRuntime({ attempt: 2 });
  await store.flush();

  assert.deepEqual(errors, ["disk full"]);
  assert.deepEqual(contexts[0], {
    critical: true,
    operation: "saveRuntime",
    sessionId: null,
    stage: null
  });
  assert.equal(store.lastError.message, "disk full");
});

test("runtime-store 设置保存失败必须传播，后续重试仍可写入", async () => {
  const writes = [];
  const errors = [];
  let failOnce = true;
  const store = new RuntimeStore({
    readRuntime: async () => null,
    writeRuntime: async () => {},
    readSettings: async () => ({}),
    writeSettings: async snapshot => {
      if (failOnce) { failOnce = false; throw new Error("settings disk full"); }
      writes.push(snapshot);
    },
    onError: (error, context) => errors.push({ message:error.message, ...context })
  });

  await assert.rejects(() => store.saveSettings({ modules:[{ name:"新事情" }] }), /settings disk full/);
  await store.saveSettings({ modules:[{ name:"重试成功" }] });
  await store.flush();

  assert.deepEqual(writes, [{ modules:[{ name:"重试成功" }] }]);
  assert.deepEqual(errors, [{ message:"settings disk full", critical:true, operation:"saveSettings" }]);
});
