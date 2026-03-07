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
  "node-pty", // Native module
  "better-sqlite3", // Native module
  "esbuild", // Build tool
  "copytree", // Externalize to preserve file structure (config files)
  "simple-git", // Externalize to avoid dynamic require issues
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
    const electronOutDir = path.join(root, "dist-electron/electron");
    if (fs.existsSync(electronOutDir)) {
      fs.rmSync(electronOutDir, { recursive: true, force: true });
    }
  }

  // Config for ESM files (Main, Hosts)
  const esmConfig = {
    ...common,
    entryPoints: ["electron/main.ts", "electron/pty-host.ts", "electron/workspace-host.ts"],
    outdir: "dist-electron/electron",
    format: "esm",
    splitting: true, // Share chunks between main/hosts
    chunkNames: "chunks/[name]-[hash]",
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
      console.log("[Build] Watching for changes...");
    } else {
      await Promise.all([build(esmConfig), build(cjsConfig)]);
      copyBuiltInWorkflows();
      writeBuildReadyMarker();
      console.log("[Build] Complete.");
    }
  } catch (error) {
    console.error("[Build] Failed:", error);
    process.exit(1);
  }
}

run();
