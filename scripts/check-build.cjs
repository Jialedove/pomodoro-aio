const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

function digest() {
  return crypto.createHash("sha256").update(fs.readFileSync("main.js")).digest("hex");
}

const before = digest();
const result = spawnSync(process.execPath, ["esbuild.config.mjs", "--production"], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status || 1);

const after = digest();
if (before !== after) throw new Error("main.js is not deterministic across identical production builds");
if (process.env.CI) {
  const tracked = spawnSync("git", ["diff", "--exit-code", "--", "main.js"], { stdio: "inherit" });
  if (tracked.status !== 0) throw new Error("committed main.js differs from the production build");
}
console.log("build artifact consistency passed");
