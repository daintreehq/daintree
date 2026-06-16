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
 * Copy each built-in plugin's `plugin.json` next to its compiled main entry so
 * `PluginService.loadPlugin` can read the manifest from the same directory
 * tree it scans at runtime. The compiled JS lands via esbuild; this step
 * mirrors the static manifest alongside it.
 */
function copyBuiltInPluginManifests() {
  const pluginsRoot = path.join(root, "plugins/builtin");
  if (!fs.existsSync(pluginsRoot)) return;
  const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestSrc = path.join(pluginsRoot, entry.name, "plugin.json");
    if (!fs.existsSync(manifestSrc)) continue;
    const manifestDest = path.join(
      root,
      "dist-electron/plugins/builtin",
      entry.name,
      "plugin.json"
    );
    fs.mkdirSync(path.dirname(manifestDest), { recursive: true });
    fs.copyFileSync(manifestSrc, manifestDest);
    console.log(`[Build] Copied built-in plugin manifest: ${entry.name}`);
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
    const manifestSrc = path.join(pluginsRoot, entry.name, "plugin.json");
    if (!fs.existsSync(manifestSrc)) continue;
    const manifestDest = path.join(root, "dist-electron/plugins/sample", entry.name, "plugin.json");
    fs.mkdirSync(path.dirname(manifestDest), { recursive: true });
    fs.copyFileSync(manifestSrc, manifestDest);
    console.log(`[Build] Copied sample plugin manifest: ${entry.name}`);

    // Copy any hand-authored `view/` assets verbatim. Plugin view modules are
    // browser-ready ESM served over `plugin://` with bare `react` specifiers
    // resolved through the host import map — esbuild must NOT process them
    // (it would bundle React in and break the single-instance contract), so
    // these are copied, not built. Used by the rich-daintree panel-view E2E
    // (#10512).
    const viewSrc = path.join(pluginsRoot, entry.name, "view");
    if (fs.existsSync(viewSrc)) {
      const viewDest = path.join(root, "dist-electron/plugins/sample", entry.name, "view");
      fs.cpSync(viewSrc, viewDest, { recursive: true });
      console.log(`[Build] Copied sample plugin view assets: ${entry.name}`);
    }
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

  if (isProd && !isWatch) {
    // Clean both the electron host bundles and the built-in plugin outputs
    // so a renamed source file or removed contribution does not survive
    // between production builds and ship inside `dist-electron/**/*`.
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
      console.log("[Build] Watching for changes...");
    } else {
      await Promise.all([build(esmConfig), build(cjsConfig)]);
      copyBuiltInWorkflows();
      copyBuiltInPluginManifests();
      copySamplePluginManifests();
      writeBuildReadyMarker();
      console.log("[Build] Complete.");
    }
  } catch (error) {
    console.error("[Build] Failed:", error);
    process.exit(1);
  }
}

run();
