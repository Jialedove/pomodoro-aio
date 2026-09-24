import { chmod, mkdir } from "node:fs/promises";
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
const output = path.join(outputDir, "pomodoro-blackout");
const source = path.join(root, "native", "BlackoutOverlay.swift");
const result = spawnSync("xcrun", ["swiftc", "-module-cache-path", cacheDir, source, "-o", output], {
  cwd:root,
  stdio:"inherit"
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
await chmod(output, 0o755);
console.log(`Built ${output}`);
