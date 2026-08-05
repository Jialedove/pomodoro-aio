import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");
const options = {
  entryPoints: ["src/main.js"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "browser",
  target: "es2020",
  minify: production,
  sourcemap: false,
  outfile: "main.js",
  banner: {
    js: "// GENERATED FILE — edit src/main.js, then run npm run build."
  }
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Watching src/main.js and its modules...");
} else {
  await esbuild.build(options);
}
