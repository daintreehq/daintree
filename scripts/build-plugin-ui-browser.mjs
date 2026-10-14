#!/usr/bin/env node

// Builds the plugin UI kit for a plain browser page, shipped in
// `@daintreehq/plugin-sdk` as `./testing/plugin-ui` and `./testing/preview.css`:
//
//   browser/plugin-ui.js   `@daintreehq/plugin-ui` as one ES module, React left
//                          to the page's import map (one React, #11296)
//   browser/preview.css    the host stylesheet, src/index.css itself, compiled
//                          with utilities for exactly the classes the kit uses,
//                          plus the kit's own sheets
//   browser/assets/        the fonts and images the stylesheet points at
//
// The CSS is the app's own source compiled again, never a copy, so the preview
// cannot drift from the app. The output goes beside `dist/` rather than in it:
// the SDK's `prepare` empties `dist/` and runs tsup on every install, and this
// build is too heavy for that.
//
// Usage: node scripts/build-plugin-ui-browser.mjs

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { build } from "vite";
import {
  REACT_SPECIFIER,
  dropFullWindowRule,
  facadeRequiredExports,
  readStringArray,
  rewriteLocalUrls,
  scannableModules,
  validateKitBundle,
} from "./lib/plugin-ui-browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "packages/plugin-sdk/browser");
const ENTRY = path.join(SRC, "pluginUi/index.ts");
const HOST_STYLESHEET = path.join(SRC, "index.css");

const started = Date.now();

const result = await build({
  configFile: false,
  root: ROOT,
  mode: "production",
  // A developer's `.env` has no business in a published file.
  envDir: false,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    // The app's aliases into source (vite.config.ts), minus the ones only the
    // host's facades and preview page need.
    alias: {
      "@": SRC,
      "@shared": path.join(ROOT, "shared"),
      "@daintreehq/tour/react": path.join(ROOT, "packages/tour/src/react.ts"),
      "@daintreehq/tour/kit": path.join(ROOT, "packages/tour/src/kit.ts"),
      "@daintreehq/tour/mock-app": path.join(ROOT, "packages/tour/src/mock-app.ts"),
      "@daintreehq/tour": path.join(ROOT, "packages/tour/src/index.ts"),
      "@daintreehq/plugin-ui": ENTRY,
      "@daintreehq/plugin-sdk/react": path.join(ROOT, "packages/plugin-sdk/src/react.ts"),
      // The worker-safe build the app pins too (see vite.config.ts).
      "decode-named-character-reference": path.join(
        ROOT,
        "node_modules/decode-named-character-reference/index.js"
      ),
    },
  },
  build: {
    write: false,
    target: "es2022",
    minify: true,
    sourcemap: false,
    reportCompressedSize: false,
    cssCodeSplit: false,
    lib: { entry: ENTRY, formats: ["es"], fileName: () => "plugin-ui.js", cssFileName: "kit" },
    rolldownOptions: {
      external: (id) => REACT_SPECIFIER.test(id),
      // One file: an import map names one module per specifier, and a chunk
      // pointed at by URL would be an undocumented second contract (#11216).
      output: { codeSplitting: false },
    },
  },
});

const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output);
const chunks = outputs.filter((file) => file.type === "chunk");
const componentCss = outputs
  .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
  .map((file) => String(file.source))
  .join("\n");

const problems = validateKitBundle({
  chunks,
  hostSpecifiers: readStringArray(
    readFileSync(path.join(ROOT, "packages/plugin-vite/src/hostImportMap.ts"), "utf-8"),
    "HOST_IMPORTMAP_SPECIFIERS"
  ),
  requiredExports: facadeRequiredExports(readFileSync(path.join(ROOT, "vite.config.ts"), "utf-8")),
});
if (problems.length > 0) {
  console.error(`[build-plugin-ui-browser] the kit cannot ship:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const [kit] = chunks;

// Utilities for exactly the classes in the kit's own source, scanned from the
// files Vite bundled rather than from the repo, which would ship the app's.
const scanned = scannableModules(kit.moduleIds, ROOT);
const compiler = await compile(readFileSync(HOST_STYLESHEET, "utf-8"), {
  base: SRC,
  from: HOST_STYLESHEET,
  shouldRewriteUrls: true,
  onDependency: () => {},
});
// By content: given only a path, a scanner with no sources of its own finds nothing.
const candidates = new Scanner({}).scanFiles(
  scanned.map((file) => ({
    content: readFileSync(file, "utf-8"),
    extension: path.extname(file).slice(1),
  }))
);
const hostCss = dropFullWindowRule(compiler.build(candidates));
// The kit's sheets load after the host's in the app (they come with the kit's
// chunk), and unlayered, which MarkdownDocument.css and syntax-tokens.css rely on.
const optimized = optimize(`${hostCss}\n${componentCss}`, { minify: false }).code;
const { css, assets } = rewriteLocalUrls(optimized, SRC, existsSync);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, "assets"), { recursive: true });
writeFileSync(path.join(OUT, "plugin-ui.js"), kit.code);
writeFileSync(path.join(OUT, "preview.css"), css);
for (const { source, target } of assets) copyFileSync(source, path.join(OUT, target));

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
console.log(
  `[build-plugin-ui-browser] plugin-ui.js ${kb(kit.code.length)}, preview.css ${kb(css.length)} ` +
    `(${candidates.length} classes from ${scanned.length} files), ${assets.length} assets ` +
    `in ${((Date.now() - started) / 1000).toFixed(1)}s`
);
