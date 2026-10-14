import { chmod, copyFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = process.env.OBSIDIAN_PLUGIN_DIR || "/Users/dove/Obsidian_Workspace/Dove的卡片库/.obsidian/plugins/pomodoro-aio";
const artifacts = ["main.js", "manifest.json", "styles.css"];
const nativeBinaries = ["pomodoro-blackout", "pomodoro-accounting"];
if (process.platform === "darwin") {
  for (const name of nativeBinaries) {
    const binary = await stat(path.join(projectRoot, "bin", name));
    if (!binary.isFile() || !(binary.mode & 0o111)) throw new Error(`Native binary ${name} is missing or not executable`);
  }
}

await mkdir(pluginDir, { recursive: true });
for (const name of artifacts) {
  const temporary = path.join(pluginDir, `.${name}.installing`);
  await copyFile(path.join(projectRoot, name), temporary);
  await rename(temporary, path.join(pluginDir, name));
}

if (process.platform === "darwin") {
  const nativeDir = path.join(pluginDir, "bin");
  await mkdir(nativeDir, { recursive:true });
  for (const name of nativeBinaries) {
    const nativeTarget = path.join(nativeDir, name);
    const temporary = `${nativeTarget}.installing`;
    await copyFile(path.join(projectRoot, "bin", name), temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, nativeTarget);
    artifacts.push(`bin/${name}`);
  }
}

console.log(`Installed ${artifacts.join(", ")} to ${pluginDir}`);
console.log("Preserved data.json. Reload Pomodoro AIO in Obsidian to apply the build.");
