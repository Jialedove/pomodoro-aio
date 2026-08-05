const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const root = path.join(projectRoot, "src");

function collect(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collect(target));
    else if (entry.isFile() && target.endsWith(".js")) files.push(target);
  }
  return files;
}

for (const file of collect(root).sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

const tsc = path.join(projectRoot, "node_modules/typescript/bin/tsc");
const typeResult = spawnSync(process.execPath, [tsc, "--project", path.join(projectRoot, "jsconfig.json"), "--pretty", "false"], {
  cwd: projectRoot,
  stdio: "inherit"
});
if (typeResult.status !== 0) process.exit(typeResult.status || 1);

console.log("typecheck passed (syntax + TypeScript checkJs)");
