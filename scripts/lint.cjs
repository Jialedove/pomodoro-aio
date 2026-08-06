const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
const jsconfig = JSON.parse(fs.readFileSync(path.join(projectRoot, "jsconfig.json"), "utf8"));

if (jsconfig.compilerOptions?.strict !== true || jsconfig.compilerOptions?.noImplicitAny === false) {
  throw new Error("TypeScript checkJs must keep strict mode enabled");
}
if (!packageJson.devDependencies?.eslint || !/^eslint\b/.test(packageJson.scripts?.lint || "")) {
  throw new Error("npm run lint must execute the installed ESLint");
}

if (packageJson.version !== manifest.version) {
  throw new Error(`package.json and manifest.json versions differ: ${packageJson.version} vs ${manifest.version}`);
}
const minAppVersion = String(manifest.minAppVersion || "0").split(".").map(Number);
const major = Number.isFinite(minAppVersion[0]) ? minAppVersion[0] : 0;
const minor = Number.isFinite(minAppVersion[1]) ? minAppVersion[1] : 0;
const patch = Number.isFinite(minAppVersion[2]) ? minAppVersion[2] : 0;
if (major < 1 || (major === 1 && (minor < 8 || (minor === 8 && patch < 7)))) {
  throw new Error("manifest.minAppVersion must support App.loadLocalStorage/saveLocalStorage (>= 1.8.7)");
}

const sourceRoot = path.join(projectRoot, "src");
const errors = [];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.isFile() && file.endsWith(".js")) {
      const source = fs.readFileSync(file, "utf8");
      if (/catch\s*\{\s*\}/.test(source)) errors.push(`${path.relative(projectRoot, file)}: empty catch block`);
    }
  }
}
scan(sourceRoot);

if (errors.length) throw new Error(errors.join("\n"));
console.log("project validation passed");
