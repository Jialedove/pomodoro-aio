const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("正式源码不重新引入旧模式字段", () => {
  const root = path.join(__dirname, "..", "src");
  const banned = /cycleTaskA|cycleTaskB|cycleSlot|cycleBreakEvery|longFocus|workMode\s*===\s*["'](?:cycle|standard)["']|currentTaskName|breakContinuation/;
  /** @param {string} dir */
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes:true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (file !== path.join(root, "legacy")) scan(file);
      } else if (entry.name.endsWith(".js")) {
        assert.doesNotMatch(fs.readFileSync(file, "utf8"), banned, path.relative(root, file));
      }
    }
  }
  scan(root);
});

test("V5 运行归一化和事件处理不依赖旧架构", () => {
  const root = path.join(__dirname, "..", "src");
  const runtime = fs.readFileSync(path.join(root, "core", "runtime.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  assert.doesNotMatch(runtime, /(?:require|import).*legacy/);
  assert.doesNotMatch(main, /reduceLegacyRuntime|isLegacyRuntimeEvent/);
});
