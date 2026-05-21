import { build, context } from "esbuild";
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
  "copytree", // Externalize to preserve file structure (config files)
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
      "plugins/builtin/github/main/index.ts",
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
      console.log("[Build] Watching for changes...");
    } else {
      await Promise.all([build(esmConfig), build(cjsConfig)]);
      copyBuiltInWorkflows();
      copyBuiltInPluginManifests();
      writeBuildReadyMarker();
      console.log("[Build] Complete.");
    }
  } catch (error) {
    console.error("[Build] Failed:", error);
    process.exit(1);
  }
}

run();
