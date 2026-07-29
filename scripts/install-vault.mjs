import { copyFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = process.env.OBSIDIAN_PLUGIN_DIR;
const artifacts = ["main.js", "manifest.json", "styles.css"];

if (!pluginDir) {
  throw new Error("Set OBSIDIAN_PLUGIN_DIR to the target plugin directory.");
}

await mkdir(pluginDir, { recursive: true });
for (const name of artifacts) {
  const temporary = path.join(pluginDir, `.${name}.installing`);
  await copyFile(path.join(projectRoot, name), temporary);
  await rename(temporary, path.join(pluginDir, name));
}

console.log(`Installed ${artifacts.join(", ")} to ${pluginDir}`);
console.log("Preserved data.json. Reload Pomodoro AIO in Obsidian to apply the build.");
