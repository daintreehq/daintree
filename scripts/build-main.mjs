import { build, context } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const isWatch = process.argv.includes("--watch");
const isProd = process.env.NODE_ENV === "production";
const buildReadyFile = path.join(root, "dist-electron/.build-ready.js");
let buildReadyTimer = null;

const external = [
  "electron",
  "@parcel/watcher", // Native N-API module (FSEvents)
  "node-pty", // Native module
  "better-sqlite3", // Native module
  "win-job-object", // Native module — Windows-only help-session Job Object (#7526)
  "posix-pty-reaper", // Native module — macOS/Linux help-session PTY supervisor (#8769)
  "copytree", // Externalize to preserve file structure (config files)
  "onnxruntime-node", // Native module — ONNX runtime for Silero VAD (#9177)
  "avr-vad", // Silero VAD wrapper; loads its bundled .onnx via fs from its own dir (#9177)
];

const common = {
  bundle: true,
  minify: isProd,
  sourcemap: !isProd,
  platform: "node",
  target: "node22",
  external,
  logLevel: "info",
  absWorkingDir: root,
  pure: isProd ? ["console.log", "console.info", "console.warn", "console.debug"] : [],
  define: {
    "process.env.SENTRY_DSN": JSON.stringify(process.env.SENTRY_DSN || ""),
    // Strip E2E test backdoors from production builds (#9148). Replacing these
    // env-var reads with "" lets esbuild constant-fold the `=== "1"` checks to
    // false and dead-code-eliminate the `contextBridge.exposeInMainWorld` blocks
    // in preload.cts (plus the matching main-process test guards). Conditional
    // spread, not a ternary value — esbuild stringifies a bare `undefined` define
    // as the literal "undefined", so dev/test builds must omit these keys entirely
    // to keep the branches intact for the E2E harness.
    ...(isProd
      ? {
          "process.env.DAINTREE_E2E_FAULT_MODE": JSON.stringify(""),
          "process.env.DAINTREE_E2E_MODE": JSON.stringify(""),
          "process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS": JSON.stringify(""),
          // The plugin host-contract harness (#9286) reads this to point
          // PluginService at the compiled sample plugin during e2e. A
          // non-empty value in prod would silently redirect the user-plugin
          // root, so it MUST be stripped alongside the other E2E flags.
          "process.env.DAINTREE_E2E_SIDELOAD_PLUGIN_DIR": JSON.stringify(""),
          // Remaining main-process E2E flags (#10026). These were read
          // ungated in main-process code but never stripped, so the names
          // survived in dist-electron/electron/*.js. Strip them too — the
          // check-preload-backdoors gate now scans the main bundles and the
          // STRIPPED_BY_BUILD list there must match these keys.
          "process.env.DAINTREE_E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE": JSON.stringify(""),
          "process.env.DAINTREE_E2E_CRASH_DUMPS_DIR": JSON.stringify(""),
          "process.env.DAINTREE_E2E_DEFER_RENDERER_LOAD": JSON.stringify(""),
          "process.env.DAINTREE_E2E_WORKSPACE_LOAD_DELAY_MS": JSON.stringify(""),
        }
      : {}),
  },
};

function removeBuildReadyMarker() {
  if (fs.existsSync(buildReadyFile)) {
    fs.rmSync(buildReadyFile, { force: true });
  }
}

function writeBuildReadyMarker() {
  fs.mkdirSync(path.dirname(buildReadyFile), { recursive: true });
  fs.writeFileSync(buildReadyFile, `// build ready ${Date.now()}\n`, "utf8");
}

function scheduleBuildReadyMarker() {
  if (buildReadyTimer) {
    clearTimeout(buildReadyTimer);
  }

  buildReadyTimer = setTimeout(() => {
    writeBuildReadyMarker();
    buildReadyTimer = null;
  }, 100);
}

/**
 * Discover each built-in plugin's main entry (`plugins/builtin/<name>/main/index.ts`)
 * so adding a new built-in plugin needs no build-config edit. Mirrors
 * `copyBuiltInPluginManifests`, which auto-discovers the same directories.
 */
function discoverBuiltInPluginMainEntries() {
  const pluginsRoot = path.join(root, "plugins/builtin");
  if (!fs.existsSync(pluginsRoot)) return [];
  const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `plugins/builtin/${entry.name}/main/index.ts`)
    .filter((rel) => fs.existsSync(path.join(root, rel)));
}

/**
 * Discover each sample plugin's main entry (`plugins/sample/<name>/main/index.ts`)
 * so adding a new sample plugin needs no build-config edit. Mirrors
 * `discoverBuiltInPluginMainEntries` and `copySamplePluginManifests`. A
 * manifest-only sample dir (no `main/index.ts`) is skipped here but still has its
 * manifest validated and copied by the manifest steps.
 */
function discoverSamplePluginMainEntries() {
  const pluginsRoot = path.join(root, "plugins/sample");
  if (!fs.existsSync(pluginsRoot)) return [];
  const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `plugins/sample/${entry.name}/main/index.ts`)
    .filter((rel) => fs.existsSync(path.join(root, rel)));
}

/**
 * Validate every `plugins/{builtin,sample}/*\/plugin.json` against the runtime
 * Zod schema (`electron/schemas/plugin.ts`) before any output is emitted, so a
 * malformed manifest fails the build loudly instead of surfacing only when the
 * app loads the plugin. Runs in a `tsx` child process — the schema is TypeScript
 * and this build script is plain ESM. Exits non-zero on the first invalid
 * manifest (the child prints the offending file + field).
 */
function validatePluginManifests() {
  const validator = path.join(root, "scripts/validate-plugin-manifests.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", validator], {
    stdio: "inherit",
    cwd: root,
  });
  if (result.status !== 0) {
    console.error("[Build] Plugin manifest validation failed.");
    process.exit(1);
  }
}

function copyBuiltInWorkflows() {
  const workflowsSrcDir = path.join(root, "electron/workflows");
  const workflowsDestDir = path.join(root, "dist-electron/workflows");
  if (fs.existsSync(workflowsSrcDir)) {
    fs.mkdirSync(workflowsDestDir, { recursive: true });
    fs.cpSync(workflowsSrcDir, workflowsDestDir, { recursive: true });
    console.log("[Build] Copied built-in workflows");
  } else {
    console.warn(`[Build] Built-in workflows directory not found: ${workflowsSrcDir}`);
  }
}

/**
 * Plugin source subdirectories the asset-copy step must NOT mirror verbatim:
 * `main/` is compiled by esbuild into the same output tree, `renderer/` is
 * consumed by the host's Vite renderer build (not loaded by the plugin at
 * runtime), `shared/` holds `import type`-only siblings esbuild erases (never
 * loaded at runtime — same compile-time category as `main`/`renderer`), and
 * `__tests__/` is dev-only. Every other subdirectory a plugin bundles (`bin/`,
 * `mcp/`, `view/`, …) is shipped as-is so `./`-relative `command`/`args` paths
 * resolve at runtime instead of ENOENT-ing (#10579).
 */
export const PLUGIN_EXTRA_ASSET_SKIP_DIRS = new Set(["main", "renderer", "shared", "__tests__"]);

/**
 * True when `child` resolves to a path strictly inside `parent` — guards the
 * asset copy/validation against `./`-relative manifest paths that escape the
 * plugin directory via `..` segments. `mcpServers[].command` is not refined the
 * way agent commands are (electron/schemas/plugin.ts), so a manifest can name
 * `./../sibling` and pass schema validation.
 */
function isInsideDir(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Read a plugin's `plugin.json` and return its `./`-relative `command`/`args`
 * asset paths. Tolerant of a missing/unparseable manifest (returns `[]`) — the
 * dedicated manifest validation step is what reports those loudly.
 */
function readManifestRelativeAssetPaths(pluginDir) {
  const manifestPath = path.join(pluginDir, "plugin.json");
  if (!fs.existsSync(manifestPath)) return [];
  try {
    return collectRelativeAssetPaths(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  } catch {
    return [];
  }
}

/**
 * Mirror every non-compiled plugin asset next to the compiled main entry. Before
 * #10579 only `plugin.json` (and a hardcoded `view/` for samples) was copied, so
 * a plugin's `bin/` agent scripts or `mcp/` servers were silently dropped from
 * the build and failed at spawn time. This copies all subdirectories except
 * those in `PLUGIN_EXTRA_ASSET_SKIP_DIRS` verbatim, plus any top-level file a
 * `./`-relative `command`/`args` path names directly (a script can live beside
 * `plugin.json` rather than in a bundled dir). `fs.cpSync` preserves executable
 * bits on macOS/Linux (Node 22).
 */
export function copyPluginExtraAssets(srcPluginDir, destPluginDir) {
  if (!fs.existsSync(srcPluginDir)) return [];
  const copied = [];
  fs.mkdirSync(destPluginDir, { recursive: true });
  for (const entry of fs.readdirSync(srcPluginDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (PLUGIN_EXTRA_ASSET_SKIP_DIRS.has(entry.name)) continue;
    const src = path.join(srcPluginDir, entry.name);
    const dest = path.join(destPluginDir, entry.name);
    fs.cpSync(src, dest, { recursive: true });
    copied.push(entry.name);
  }
  // Top-level asset files named by a `./`-relative command/arg that live beside
  // the manifest rather than inside a bundled dir; files already shipped via
  // their directory above are skipped (dest exists).
  for (const relPath of readManifestRelativeAssetPaths(srcPluginDir)) {
    const src = path.resolve(srcPluginDir, relPath);
    if (!isInsideDir(src, srcPluginDir)) continue;
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    const dest = path.resolve(destPluginDir, relPath);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push(relPath);
  }
  return copied;
}

/**
 * Copy each built-in plugin's `plugin.json` next to its compiled main entry so
 * `PluginService.loadPlugin` can read the manifest from the same directory
 * tree it scans at runtime. The compiled JS lands via esbuild; this step
 * mirrors the static manifest and any bundled asset directories alongside it.
 */
function copyBuiltInPluginManifests() {
  const pluginsRoot = path.join(root, "plugins/builtin");
  if (!fs.existsSync(pluginsRoot)) return;
  const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const srcPluginDir = path.join(pluginsRoot, entry.name);
    const manifestSrc = path.join(srcPluginDir, "plugin.json");
    if (!fs.existsSync(manifestSrc)) continue;
    const destPluginDir = path.join(root, "dist-electron/plugins/builtin", entry.name);
    const manifestDest = path.join(destPluginDir, "plugin.json");
    fs.mkdirSync(destPluginDir, { recursive: true });
    fs.copyFileSync(manifestSrc, manifestDest);
    const copied = copyPluginExtraAssets(srcPluginDir, destPluginDir);
    const extra = copied.length > 0 ? ` (+ ${copied.join(", ")})` : "";
    console.log(`[Build] Copied built-in plugin manifest: ${entry.name}${extra}`);
  }
}

/**
 * Mirror `plugin.json` manifests for `plugins/sample/*` alongside their
 * compiled main entries. Sample plugins are not loaded at runtime by default —
 * the host-contract e2e harness (#9286) sideloads them via
 * `DAINTREE_E2E_SIDELOAD_PLUGIN_DIR` pointing at `dist-electron/plugins/sample`.
 */
function copySamplePluginManifests() {
  const pluginsRoot = path.join(root, "plugins/sample");
  if (!fs.existsSync(pluginsRoot)) return;
  const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const srcPluginDir = path.join(pluginsRoot, entry.name);
    const manifestSrc = path.join(srcPluginDir, "plugin.json");
    if (!fs.existsSync(manifestSrc)) continue;
    const destPluginDir = path.join(root, "dist-electron/plugins/sample", entry.name);
    const manifestDest = path.join(destPluginDir, "plugin.json");
    fs.mkdirSync(destPluginDir, { recursive: true });
    fs.copyFileSync(manifestSrc, manifestDest);

    // Copy every bundled asset directory verbatim — `view/` (browser-ready ESM
    // served over `plugin://`; esbuild must NOT process it or it would bundle
    // React in and break the single-instance contract — used by the
    // rich-daintree panel-view E2E #10512), plus any `bin/`/`mcp/` scripts a
    // plugin spawns via `./`-relative `command`/`args` (#10579).
    const copied = copyPluginExtraAssets(srcPluginDir, destPluginDir);
    const extra = copied.length > 0 ? ` (+ ${copied.join(", ")})` : "";
    console.log(`[Build] Copied sample plugin manifest: ${entry.name}${extra}`);
  }
}

/**
 * Collect the `./`-relative file paths a copied plugin manifest will spawn —
 * agent `command`/`args` and MCP server `command`/`args`. Bare PATH binaries
 * (`echo`, `node`) and absolute/`..` paths are rejected at manifest-validation
 * time, so only `./`-prefixed entries name a file the build must have shipped.
 */
function collectRelativeAssetPaths(manifest) {
  const paths = [];
  const contributes = manifest?.contributes ?? {};
  const sources = [...(contributes.agents ?? []), ...(contributes.mcpServers ?? [])];
  for (const source of sources) {
    for (const value of [source?.command, ...(source?.args ?? [])]) {
      if (typeof value === "string" && value.startsWith("./")) paths.push(value);
    }
  }
  return paths;
}

/**
 * Walk the copied plugin output and report every `./`-relative `command`/`args`
 * path that does not resolve to a real file. The copy step ships whole
 * directories, but a manifest can still reference a path the author never
 * created — that surfaced only as a runtime ENOENT before #10579. Pure (no
 * exit/logging) and parameterized on the dist plugins root so it is unit
 * testable; `distPluginsRoot` missing entirely (cold build) yields `[]`.
 */
export function findMissingPluginAssets(distPluginsRoot) {
  const missing = [];
  for (const tier of ["builtin", "sample"]) {
    const tierRoot = path.join(distPluginsRoot, tier);
    if (!fs.existsSync(tierRoot)) continue;
    for (const entry of fs.readdirSync(tierRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(tierRoot, entry.name);
      const manifestPath = path.join(pluginDir, "plugin.json");
      if (!fs.existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (error) {
        missing.push(`${tier}/${entry.name}: unreadable plugin.json (${error.message})`);
        continue;
      }
      for (const relPath of collectRelativeAssetPaths(manifest)) {
        const resolved = path.resolve(pluginDir, relPath);
        if (!isInsideDir(resolved, pluginDir)) {
          missing.push(`${tier}/${entry.name}: "${relPath}" escapes the plugin directory`);
          continue;
        }
        if (!fs.existsSync(resolved)) {
          missing.push(`${tier}/${entry.name}: "${relPath}" not found in built output`);
        }
      }
    }
  }
  return missing;
}

/**
 * After the manifests and their asset directories are copied, fail the build if
 * any `./`-relative `command`/`args` path is missing from the output. In watch
 * mode unresolved paths only warn (a cold build may not have emitted output
 * yet); in a single/production build they fail the build loudly.
 */
function validateCopiedPluginAssets() {
  const missing = findMissingPluginAssets(path.join(root, "dist-electron/plugins"));
  if (missing.length === 0) return;

  const detail = missing.map((m) => `  - ${m}`).join("\n");
  if (isWatch) {
    console.warn(`[Build] Plugin asset paths missing from output:\n${detail}`);
    return;
  }
  console.error(`[Build] Plugin asset paths missing from output:\n${detail}`);
  process.exit(1);
}

/**
 * Scan each source plugin's declared `contributes.commands` and report any whose
 * handler module is authored as TypeScript (`src/{id}.ts` / `src/{id}.tsx`).
 * `COMMAND_HANDLER_EXTENSIONS` in PluginService.ts probes only `.js`/`.mjs` at
 * runtime (#10620): a `.ts` handler is either never found or throws a
 * `SyntaxError` at first dispatch under Node's type-stripping (non-erasable
 * syntax), and `.tsx` never runs. Catching it at build time turns a runtime
 * footgun into a loud failure. Pure (no exit/logging) and parameterized on the
 * source plugins root so it is unit testable; a missing root yields `[]`.
 */
export function findTypeScriptCommandHandlers(pluginsSrcRoot) {
  const offenders = [];
  for (const tier of ["builtin", "sample"]) {
    const tierRoot = path.join(pluginsSrcRoot, tier);
    if (!fs.existsSync(tierRoot)) continue;
    for (const entry of fs.readdirSync(tierRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(tierRoot, entry.name);
      const manifestPath = path.join(pluginDir, "plugin.json");
      if (!fs.existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch {
        // The dedicated manifest validation step reports unreadable manifests.
        continue;
      }
      const commands = manifest?.contributes?.commands ?? [];
      for (const command of commands) {
        const id = command?.id;
        if (typeof id !== "string" || id.length === 0) continue;
        // Mirrors COMMAND_HANDLER_EXTENSIONS in PluginService.ts. A loadable
        // sibling means the runtime resolves the command (e.g. a plugin
        // mid-migration keeping the .ts source beside the compiled .js), so the
        // TypeScript source is not a footgun — skip it.
        const loadableExts = [".js", ".mjs"];
        if (loadableExts.some((ext) => fs.existsSync(path.join(pluginDir, "src", `${id}${ext}`)))) {
          continue;
        }
        for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
          if (fs.existsSync(path.join(pluginDir, "src", `${id}${ext}`))) {
            offenders.push(`${tier}/${entry.name}: src/${id}${ext}`);
          }
        }
      }
    }
  }
  return offenders;
}

/**
 * Fail the build (warn in watch mode) when a plugin ships a TypeScript command
 * handler the runtime can never load (#10620). Same severity model as
 * `validateCopiedPluginAssets`: loud-and-fatal for single/production builds, a
 * warning under watch where the source may still be mid-edit.
 */
function validateCommandHandlerExtensions() {
  const offenders = findTypeScriptCommandHandlers(path.join(root, "plugins"));
  if (offenders.length === 0) return;

  const detail = offenders.map((o) => `  - ${o}`).join("\n");
  const message = `[Build] TypeScript command handlers will not load at runtime — the host probes only .js/.mjs (#10620). Compile or rewrite these as .js/.mjs:\n${detail}`;
  if (isWatch) {
    console.warn(message);
    return;
  }
  console.error(message);
  process.exit(1);
}

/**
 * Typecheck plugin code (`tsconfig.plugins.json`) before emitting output so a
 * type error in a built-in/sample plugin's main code fails the build instead of
 * surfacing at runtime (#10620). Uses `tsc --noEmit` — never `tsc -b`, which
 * emits `.js` into the source tree and would clobber the esbuild output. Skipped
 * in watch mode (a full typecheck would stall the watcher); a banner points devs
 * at `npm run check`.
 */
function runPluginTypecheck() {
  if (isWatch) {
    console.log("[Build] Plugin types skipped in watch mode — run npm run check to typecheck.");
    return;
  }
  const tscPath = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tscPath, "--noEmit", "-p", "tsconfig.plugins.json"], {
    stdio: "inherit",
    cwd: root,
  });
  if (result.status !== 0) {
    if (result.error) {
      console.error("[Build] Plugin typecheck spawn failed:", result.error);
    }
    console.error("[Build] Plugin typecheck failed.");
    process.exit(result.status ?? 1);
  }
}

function createReadyMarkerPlugin() {
  return {
    name: "build-ready-marker",
    setup(buildApi) {
      buildApi.onEnd((result) => {
        if (result.errors.length === 0) {
          scheduleBuildReadyMarker();
        }
      });
    },
  };
}

async function run() {
  console.log(`[Build] Starting build in ${isWatch ? "watch" : "single"} mode...`);
  removeBuildReadyMarker();

  // Gate the build on valid plugin manifests before cleaning or emitting any
  // output, so an invalid `plugin.json` neither wipes the prior build nor ships
  // a broken plugin (#10564).
  validatePluginManifests();

  // Reject TypeScript command handlers the runtime can never load, and
  // typecheck plugin code, before any output is emitted (#10620). Both run
  // ahead of the clean/emit so a failure leaves the prior build intact.
  validateCommandHandlerExtensions();
  runPluginTypecheck();

  {
    // Clean both the electron host bundles and the built-in plugin outputs
    // so a renamed source file or removed contribution does not survive
    // between builds and ship inside `dist-electron/**/*`.
    //
    // Runs for EVERY build, not just production. Output chunks are content-hashed,
    // and a chunk whose own content did not change keeps its name across rebuilds —
    // so an unchanged importer can survive while the chunk it imports is re-emitted
    // under a new hash and the old one is orphaned. Skipping the clean in dev left
    // exactly that: a live chunk importing a hash no longer on disk, which fails at
    // require time with "Cannot find module …/chunks/X-HASH.js imported from …".
    //
    // Safe in watch mode too: this whole function runs once per invocation, before
    // esbuild's context starts watching, so it never wipes output mid-session.
    for (const dir of ["dist-electron/electron", "dist-electron/plugins"]) {
      const abs = path.join(root, dir);
      if (fs.existsSync(abs)) {
        fs.rmSync(abs, { recursive: true, force: true });
      }
    }
  }

  // Config for ESM files (Main, Hosts, built-in plugins).
  // Built-in plugins are bundled in the same esbuild run so `splitting: true`
  // dedupes shared modules (e.g. the GitHub service singletons after #8060)
  // into a single chunk referenced by both the electron main bundle's compat
  // shims and the plugin entry that `PluginService` loads at runtime.
  const esmConfig = {
    ...common,
    entryPoints: [
      "electron/bootstrap.ts",
      "electron/main.ts",
      "electron/pty-host.ts",
      "electron/pty-host-bootstrap.ts",
      "electron/workspace-host.ts",
      "electron/workspace-host-bootstrap.ts",
      "electron/watchdog-host.ts",
      "electron/watchdog-host-bootstrap.ts",
      // Plugin dev-mode hot-reload worker (#9304): runs a dev-symlinked plugin's
      // code in a utilityProcess.fork child and respawns on each Vite rebuild.
      "electron/plugin-dev-worker.ts",
      "electron/plugin-dev-worker-bootstrap.ts",
      // VAD side-chain worker for OpenAI transcription (#9177). Loaded via
      // `new Worker()` from OpenAITranscriptionProvider; needs its own entry so
      // esbuild emits a standalone bundle at the resolved worker path.
      "electron/services/voice/openaiVadWorker.ts",
      // Multi-threading workers: per-terminal analysis (headless xterm +
      // activity detection) inside pty-host, SQLite maintenance off the main
      // event loop, and copytree generation inside workspace-host. Each is
      // loaded via `new Worker()` and needs a standalone bundle at its
      // resolved worker path (same pattern as openaiVadWorker).
      "electron/pty-host/analysisWorker.ts",
      "electron/services/persistence/dbMaintenanceWorker.ts",
      "electron/workspace-host/copytreeWorker.ts",
      ...discoverBuiltInPluginMainEntries(),
      // Sample plugins compiled for the host-contract e2e harness (#9286, #9592).
      // Sideloaded via `DAINTREE_E2E_SIDELOAD_PLUGIN_DIR`; absent in prod because
      // no `pluginsRoot` defaults to this directory. Auto-discovered so adding a
      // new sample plugin needs no build-config edit (#10564).
      ...discoverSamplePluginMainEntries(),
    ],
    outdir: "dist-electron",
    outbase: ".",
    format: "esm",
    splitting: true, // Share chunks between main/hosts/plugins
    chunkNames: "electron/chunks/[name]-[hash]",
    plugins: isWatch ? [createReadyMarkerPlugin()] : [],
    banner: {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
    },
  };

  // Config for CJS file (Preload)
  const cjsConfig = {
    ...common,
    entryPoints: ["electron/preload.cts"],
    outdir: "dist-electron/electron",
    format: "cjs",
    outExtension: { ".js": ".cjs" },
    plugins: isWatch ? [createReadyMarkerPlugin()] : [],
  };

  try {
    if (isWatch) {
      const ctxEsm = await context(esmConfig);
      const ctxCjs = await context(cjsConfig);

      await Promise.all([ctxEsm.watch(), ctxCjs.watch()]);
      copyBuiltInWorkflows();
      copyBuiltInPluginManifests();
      copySamplePluginManifests();
      validateCopiedPluginAssets();
      console.log("[Build] Watching for changes...");
    } else {
      await Promise.all([build(esmConfig), build(cjsConfig)]);
      copyBuiltInWorkflows();
      copyBuiltInPluginManifests();
      copySamplePluginManifests();
      validateCopiedPluginAssets();
      writeBuildReadyMarker();
      console.log("[Build] Complete.");
    }
  } catch (error) {
    console.error("[Build] Failed:", error);
    process.exit(1);
  }
}

// Only kick off a build when run as a script (`node scripts/build-main.mjs`),
// not when a test imports the exported copy/validate helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
