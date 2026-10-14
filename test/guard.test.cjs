const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("守护进程 LaunchAgent 配置：登录启动、常驻、转义路径", async () => {
  const { buildPlist, guardPaths, LABEL } = await import("../scripts/guard.mjs");
  const paths = guardPaths("/Users/a&b");
  assert.equal(paths.plist, `/Users/a&b/Library/LaunchAgents/${LABEL}.plist`);
  const plist = buildPlist({ binary:paths.binary, logPath:paths.logPath, args:["--grace", "60"] });
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.ok(plist.includes("<string>/Users/a&amp;b/Library/Application Support/pomodoro-aio/pomodoro-guard</string>"));
  assert.ok(plist.includes("<string>--grace</string>"));
  if (process.platform === "darwin") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pomodoro-guard-test-"));
    try {
      const file = path.join(dir, "guard.plist");
      fs.writeFileSync(file, plist);
      const lint = spawnSync("plutil", ["-lint", file], { encoding:"utf8" });
      assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    } finally {
      fs.rmSync(dir, { recursive:true, force:true });
    }
  }
});
