import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("Native blackout build skipped (macOS only).");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "bin");
const cacheDir = path.join(os.tmpdir(), "pomodoro-aio-swift-cache");
await mkdir(outputDir, { recursive:true });
await mkdir(cacheDir, { recursive:true });
const targets = [
  { source:path.join(root, "native", "BlackoutOverlay.swift"), output:path.join(outputDir, "pomodoro-blackout") },
  { source:path.join(root, "native", "AccountingScreen.swift"), output:path.join(outputDir, "pomodoro-accounting") },
  { source:path.join(root, "native", "Guard.swift"), output:path.join(outputDir, "pomodoro-guard") }
];
const args = ["swiftc", "-module-cache-path", cacheDir];
let overlayDir;
try {
  const compiler = spawnSync("xcrun", ["--find", "swiftc"], { encoding:"utf8" });
  if (compiler.error) throw compiler.error;
  if (compiler.status !== 0) throw new Error(compiler.stderr || "Swift compiler unavailable");
  const includeDir = path.resolve(path.dirname(compiler.stdout.trim()), "..", "include", "swift");
  const moduleMap = path.join(includeDir, "module.modulemap");
  const [regular, bridging] = await Promise.all([
    readFile(moduleMap, "utf8").catch(() => ""),
    readFile(path.join(includeDir, "bridging.modulemap"), "utf8").catch(() => "")
  ]);
  // Some CLT installs ship the same SwiftBridging declaration twice.
  // Hide only an identical duplicate for this invocation; leave the toolchain intact.
  const declarations = text => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, "");
  if (regular && declarations(regular) === declarations(bridging) && /^module SwiftBridging\s*\{/m.test(regular)) {
    overlayDir = await mkdtemp(path.join(os.tmpdir(), "pomodoro-aio-swift-overlay-"));
    const emptyMap = path.join(overlayDir, "empty.modulemap");
    const overlay = path.join(overlayDir, "overlay.json");
    await writeFile(emptyMap, "// SwiftBridging is declared by bridging.modulemap\n");
    await writeFile(overlay, JSON.stringify({ version:0, roots:[{
      type:"file", name:moduleMap, "external-contents":emptyMap
    }] }));
    args.push("-vfsoverlay", overlay);
    console.log("Using temporary overlay for duplicate SwiftBridging module map.");
  }
  for (const { source, output } of targets) {
    const result = spawnSync("xcrun", [...args, source, "-o", output], { cwd:root, stdio:"inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status || 1; break; }
  }
} finally {
  if (overlayDir) await rm(overlayDir, { recursive:true, force:true });
}
if (process.exitCode) process.exit(process.exitCode);
for (const { output } of targets) {
  await chmod(output, 0o755);
  console.log(`Built ${output}`);
}
