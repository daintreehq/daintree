import { build, context } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pluginSdkRuntimeBuildConfig } from "./lib/plugin-sdk-runtime.mjs";
import { asciiOnlyOutputPlugin } from "./lib/ascii-only-chunks.mjs";
import { mainBundlePlugins } from "./lib/main-bundle.mjs";
import {
  PLUGIN_TIERS,
  collectRelativeAssetPaths,
  isInsideDir,
  isReservedAssetDir,
  syncPluginTier,
  watchPluginAssets,
} from "./lib/plugin-asset-sync.mjs";
import { MAIN_EXTERNAL, MAIN_PRELOAD_ENTRY, mainEsmEntryPoints } from "./main-build-entries.mjs";
import { runProjectSync } from "./typecheck.mjs";
import canopyReaderModel from "./lib/canopyReaderModel.cjs";
import {
  BUILD_READY_FILE,
  removeBuildReadyMarker,
  startWatchBuild,
  writeBuildReadyMarker,
} from "./lib/build-ready-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const isWatch = process.argv.includes("--watch");
const isProd = process.env.NODE_ENV === "production";
const buildReadyFile = path.join(root, BUILD_READY_FILE);

const external = MAIN_EXTERNAL;

// Every build can be a Remote Hosts Shell; only macOS and Linux can be a
// Host. A Windows build compiles the Host-role gate to `false`, so every
// `if (__DAINTREE_REMOTE_HOST_ROLE__) { await import(...) }` site drops the
// listener, Host mode and the attach bridge from the bundle entirely.
// DAINTREE_BUILD_TARGET_PLATFORM lets a cross-build name its target.
const buildTargetPlatform = process.env.DAINTREE_BUILD_TARGET_PLATFORM || process.platform;
const remoteHostsEnabled = true;
const remoteHostRoleEnabled = buildTargetPlatform !== "win32";

// Client and host must run the same source commit, so the commit is baked in.
function resolveBuildCommit() {
  if (process.env.DAINTREE_BUILD_COMMIT) return process.env.DAINTREE_BUILD_COMMIT;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}
const buildCommit = resolveBuildCommit();

/**
 * The build's version and commit as a marker file packed into the app. A
 * client probing a machine over SSH reads it straight out of the archive
 * (the bytes are stored uncompressed), so it can tell which build is
 * installed there without launching it. Keys and order are fixed: the probe
 * matches this exact shape.
 */
export function formatBuildInfo(version, commit) {
  return JSON.stringify({ daintreeBuildInfo: 1, version, commit });
}

function writeBuildInfo() {
  // A packaging step that stamps its own version (a local build's
  // extraMetadata.version) names it here, so the marker matches what the app
  // reports and what a host install checks against.
  const version =
    process.env.DAINTREE_BUILD_VERSION ||
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const target = path.join(root, "dist-electron/build-info.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, formatBuildInfo(version, buildCommit), "utf8");
}

/** Options every Node build of main shares, for a production build or not. */
function commonOptions({ production }) {
  return {
    bundle: true,
    minify: production,
    sourcemap: !production,
    platform: "node",
    target: "node22",
    external,
    logLevel: "info",
    absWorkingDir: root,
    pure: production ? ["console.log", "console.info", "console.warn", "console.debug"] : [],
    define: {
      "process.env.SENTRY_DSN": JSON.stringify(process.env.SENTRY_DSN || ""),
      __DAINTREE_REMOTE_HOSTS__: JSON.stringify(remoteHostsEnabled),
      __DAINTREE_REMOTE_HOST_ROLE__: JSON.stringify(remoteHostRoleEnabled),
      __DAINTREE_BUILD_COMMIT__: JSON.stringify(buildCommit),
      // Strip E2E test backdoors from production builds (#9148). Replacing these
      // env-var reads with "" lets esbuild constant-fold the `=== "1"` checks to
      // false and dead-code-eliminate the `contextBridge.exposeInMainWorld` blocks
      // in preload.cts (plus the matching main-process test guards). Conditional
      // spread, not a ternary value — esbuild stringifies a bare `undefined` define
      // as the literal "undefined", so dev/test builds must omit these keys entirely
      // to keep the branches intact for the E2E harness.
      ...(production
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
}

/**
 * The core Element Picker's guest bundles: a fixed list, not discovered from
 * any manifest, because no plugin owns them. Restates `CORE_GUEST_ASSET_FILES`
 * in `electron/services/elementPicker/guestAssets.ts`, which reads them back at
 * runtime; `scripts/__tests__/core-picker-assets.test.mjs` pins the two
 * together. Each is evaluated by the host inside a prelude, so each is built
 * as a standalone browser IIFE.
 */
export const CORE_PICKER_GUEST_ASSETS = [
  {
    id: "bootstrap",
    entry: "electron/services/elementPicker/guest/bootstrap.ts",
    outfile: "dist-electron/element-picker/guest/bootstrap.js",
  },
  {
    id: "probe",
    entry: "electron/services/elementPicker/guest/probe.ts",
    outfile: "dist-electron/element-picker/guest/probe.js",
  },
  {
    id: "plugin-runtime",
    entry: "electron/services/elementPicker/guest/pluginRuntime.ts",
    outfile: "dist-electron/element-picker/guest/pluginRuntime.js",
  },
  {
    id: "extractor:svelte",
    entry: "electron/services/elementPicker/guest/extractors/svelte.ts",
    outfile: "dist-electron/element-picker/guest/extractors/svelte.js",
  },
  {
    id: "extractor:react",
    entry: "electron/services/elementPicker/guest/extractors/react.ts",
    outfile: "dist-electron/element-picker/guest/extractors/react.js",
  },
  {
    id: "extractor:solid",
    entry: "electron/services/elementPicker/guest/extractors/solid.ts",
    outfile: "dist-electron/element-picker/guest/extractors/solid.js",
  },
  {
    id: "extractor:vue",
    entry: "electron/services/elementPicker/guest/extractors/vue.ts",
    outfile: "dist-electron/element-picker/guest/extractors/vue.js",
  },
  {
    id: "extractor:angular",
    entry: "electron/services/elementPicker/guest/extractors/angular.ts",
    outfile: "dist-electron/element-picker/guest/extractors/angular.js",
  },
  {
    id: "extractor:astro",
    entry: "electron/services/elementPicker/guest/extractors/astro.ts",
    outfile: "dist-electron/element-picker/guest/extractors/astro.js",
  },
  {
    id: "extractor:preact",
    entry: "electron/services/elementPicker/guest/extractors/preact.ts",
    outfile: "dist-electron/element-picker/guest/extractors/preact.js",
  },
];

/**
 * Pure so it is unit testable. The wrapping banner is what keeps the emitted
 * IIFE strict: esbuild puts its own `"use strict"` at file scope, and the host
 * splices the asset inside a `try` block, where a directive prologue no longer
 * applies. `keepNames` is deliberately absent — it is the class of transform
 * that broke the serialised runtime this asset replaced.
 */
export function guestRuntimeBuildConfig(asset, options = {}) {
  return {
    entryPoints: [asset.entry],
    outfile: asset.outfile,
    bundle: true,
    format: "iife",
    platform: "browser",
    // The asset only ever runs in a Chromium 148 guest.
    target: "es2022",
    minify: options.minify === true,
    sourcemap: false,
    logLevel: "info",
    banner: { js: "(() => {" },
    footer: { js: "})();" },
    ...(options.absWorkingDir ? { absWorkingDir: options.absWorkingDir } : {}),
  };
}

/**
 * Validate every `plugins/{builtin,sample}/*\/plugin.json` against the runtime
 * Zod schema (`electron/schemas/plugin.ts`) before any output is emitted, so a
 * malformed manifest fails the build loudly instead of surfacing only when the
 * app loads the plugin. Runs in a `tsx` child process — the schema is TypeScript
 * and this build script is plain ESM. Exits non-zero on the first invalid
 * manifest (the child prints the offending file + field).
 */
const MANIFEST_VALIDATOR_ARGS = [
  "--import",
  "tsx/esm",
  path.join(root, "scripts/validate-plugin-manifests.ts"),
];

function validatePluginManifests() {
  const result = spawnSync(process.execPath, MANIFEST_VALIDATOR_ARGS, {
    stdio: "inherit",
    cwd: root,
  });
  if (result.status !== 0) {
    console.error("[Build] Plugin manifest validation failed.");
    process.exit(1);
  }
}

/**
 * The watcher's recheck after a manifest changes. It only warns: the manifest
 * is already mirrored as saved, the way an editor leaves it mid-edit, and the
 * app rejects an invalid one when it loads. Asynchronous so esbuild's watch
 * callbacks keep running while the validator starts up.
 */
function revalidatePluginManifests() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, MANIFEST_VALIDATOR_ARGS, { stdio: "inherit", cwd: root });
    child.once("error", (error) => {
      console.warn("[Build] Could not run the plugin manifest validator:", error);
      resolve();
    });
    child.once("exit", (code) => {
      if (code !== 0) console.warn("[Build] Plugin manifest validation failed.");
      resolve();
    });
  });
}

const PLUGIN_SRC_ROOT = path.join(root, "plugins");
const PLUGIN_DIST_ROOT = path.join(root, "dist-electron/plugins");

function logPluginAssetChanges(tier, { name, copied, removed }) {
  const describe = (verb, paths) =>
    paths.length === 0
      ? []
      : [
          `${verb} ${paths.slice(0, 6).join(", ")}${paths.length > 6 ? ` +${paths.length - 6}` : ""}`,
        ];
  const detail = [...describe("copied", copied), ...describe("removed", removed)].join("; ");
  console.log(`[Build] Synced ${tier} plugin ${name}: ${detail}`);
}

/**
 * Mirror each built-in and sample plugin's manifest and bundled assets next to
 * its compiled main entry, so `PluginService.loadPlugin` reads them from the
 * directory tree it scans at runtime. Sample plugins are not loaded by default:
 * the host-contract e2e harness (#9286) sideloads them via
 * `DAINTREE_E2E_SIDELOAD_PLUGIN_DIR` pointing at `dist-electron/plugins/sample`.
 */
function syncAllPluginAssets() {
  for (const tier of PLUGIN_TIERS) {
    const changed = syncPluginTier(
      path.join(PLUGIN_SRC_ROOT, tier),
      path.join(PLUGIN_DIST_ROOT, tier)
    );
    for (const plugin of changed) logPluginAssetChanges(tier, plugin);
  }
}

/**
 * Same checks as a build makes after the copy, at watch severity. Only a
 * changed manifest pays for the schema validator's start-up; the handler check
 * also runs for a source file deleted beside an unchanged one.
 */
async function recheckSyncedPluginAssets(changed) {
  for (const { tier, ...plugin } of changed) logPluginAssetChanges(tier, plugin);
  const touchesManifest = ({ copied, removed }) =>
    copied.includes("plugin.json") || removed.includes("plugin.json");
  if (changed.some(touchesManifest)) await revalidatePluginManifests();
  validateCommandHandlerExtensions();
  validateCopiedPluginAssets();
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
          const [topDir, ...rest] = path.relative(pluginDir, resolved).split(path.sep);
          const hint =
            rest.length > 0 && isReservedAssetDir(topDir)
              ? ` (the build never copies ${topDir}/: move it into a directory such as bin/, or beside plugin.json)`
              : "";
          missing.push(`${tier}/${entry.name}: "${relPath}" not found in built output${hint}`);
        }
      }
    }
  }
  return missing;
}

/**
 * Every core picker bundle absent from the output. Parameterized on the output
 * root so it is unit testable.
 */
export function findMissingCorePickerAssets(distRoot) {
  const missing = [];
  for (const asset of CORE_PICKER_GUEST_ASSETS) {
    const resolved = path.resolve(distRoot, asset.outfile.replace("dist-electron/", ""));
    if (!fs.existsSync(resolved)) {
      missing.push(`${asset.id}: "${asset.outfile}" not found in built output`);
    }
  }
  return missing;
}

/**
 * Same severity model as `validateCopiedPluginAssets`: a warning under watch,
 * where it runs once the first build is ready, and a hard failure otherwise.
 */
function validateGuestAssets() {
  const missing = findMissingCorePickerAssets(path.join(root, "dist-electron"));
  if (missing.length === 0) return;

  const detail = missing.map((m) => `  - ${m}`).join("\n");
  if (isWatch) {
    console.warn(`[Build] Core picker guest bundles missing from output:\n${detail}`);
    return;
  }
  console.error(`[Build] Core picker guest bundles missing from output:\n${detail}`);
  process.exit(1);
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
      // A half-edited manifest the watcher rechecks can have any shape.
      const commands = manifest?.contributes?.commands;
      if (!Array.isArray(commands)) continue;
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
 * surfacing at runtime (#10620). Runs the `plugins` project from
 * `scripts/typecheck.mjs`, so it uses the same TS7 compiler and arguments as
 * `npm run typecheck` (`--noEmit`, never `tsc -b`, which emits `.js` into the
 * source tree and would clobber the esbuild output). Skipped in watch mode (a
 * full typecheck would stall the watcher); a banner points devs at
 * `npm run check`.
 */
export function runPluginTypecheck({
  watch = isWatch,
  runProject = runProjectSync,
  exit = (code) => process.exit(code),
} = {}) {
  if (watch) {
    console.log("[Build] Plugin types skipped in watch mode — run npm run check to typecheck.");
    return;
  }
  const status = runProject("plugins");
  if (status !== 0) {
    console.error("[Build] Plugin typecheck failed.");
    exit(status);
  }
}

/**
 * Config for the ESM files: main, its hosts and the built-in plugins.
 * Built-in plugins are bundled in the same esbuild run so `splitting: true`
 * dedupes shared modules (e.g. the GitHub service singletons after #8060)
 * into a single chunk referenced by both the electron main bundle's compat
 * shims and the plugin entry that `PluginService` loads at runtime.
 * Exported so `scripts/__tests__/vueProductionCompilerBundle.test.ts` reads
 * what a production run of this exact config emits.
 */
export function mainEsmConfig({ production, watch = false }) {
  return {
    ...commonOptions({ production }),
    entryPoints: mainEsmEntryPoints(root),
    outdir: "dist-electron",
    outbase: ".",
    format: "esm",
    splitting: true, // Share chunks between main/hosts/plugins
    chunkNames: "electron/chunks/[name]-[hash]",
    plugins: [
      ...mainBundlePlugins({ isProd: production }),
      // Keeps the chunks Main, the pty host and its analysis workers load one
      // byte per character in V8, which a regex literal's glyph undoes (#17023).
      ...(production && !watch ? [asciiOnlyOutputPlugin()] : []),
    ],
    // The import is aliased because the banner is raw text esbuild never renames
    // around: a bundled ESM module that imports `createRequire` itself (fflate's
    // node build, under the Decisions libraries) would otherwise declare it twice
    // in one chunk, and that chunk fails to load.
    banner: {
      js: `import { createRequire as __daintreeCreateRequire } from 'module'; const require = __daintreeCreateRequire(import.meta.url);`,
    },
  };
}

async function prepareCanopyReaderModel() {
  const { fetched } = await canopyReaderModel.prepareModel();
  if (fetched.length > 0)
    console.log(`[Build] Fetched Canopy's reader model: ${fetched.join(", ")}`);
}

/**
 * Canopy's reader model ships inside the app (#16415): fetched once per
 * checkout from its pinned revision, and verified on every build. A build that
 * can't get it fails before building anything, since a package without it
 * can't read a screen. A dev watch starts building at once and prepares the
 * model beside it (#17818), so the network never holds the app's launch: the
 * unpackaged app waits for the model and reads with it only once every file
 * matches its pin. Resolves once the build has started; `model` settles when
 * the watch's preparation does, and never rejects.
 */
export async function runWithCanopyModel({ watch, prepare, startBuild, warn = console.warn }) {
  if (!watch) {
    await prepare();
    await startBuild();
    return { model: Promise.resolve() };
  }
  const building = startBuild();
  const model = Promise.resolve()
    .then(prepare)
    .catch((error) => {
      warn(
        `[Build] Canopy's reader model isn't ready (${error instanceof Error ? error.message : error}). ` +
          "Canopy reads nothing until `npm run fetch:canopy-model` succeeds."
      );
    });
  await building;
  return { model };
}

async function run() {
  console.log(`[Build] Starting build in ${isWatch ? "watch" : "single"} mode...`);
  removeBuildReadyMarker(buildReadyFile);

  // Gate the build on valid plugin manifests before cleaning or emitting any
  // output, so an invalid `plugin.json` neither wipes the prior build nor ships
  // a broken plugin (#10564).
  validatePluginManifests();

  // Reject TypeScript command handlers the runtime can never load, and
  // typecheck plugin code, before any output is emitted (#10620). Both run
  // ahead of the clean/emit so a failure leaves the prior build intact.
  validateCommandHandlerExtensions();
  runPluginTypecheck();

  if (isProd && !isWatch) {
    // Clean both the electron host bundles and the built-in plugin outputs
    // so a renamed source file or removed contribution does not survive
    // between production builds and ship inside `dist-electron/**/*`.
    // `dist-electron/shared` is no build output: typecheck emitted shared/
    // there until #16279, and a checkout's leftover copy would still ship.
    // Nor is `dist-electron/workflows`, copied until the DAG workflow system
    // and its loader were removed.
    for (const dir of [
      "dist-electron/electron",
      "dist-electron/plugins",
      "dist-electron/shared",
      "dist-electron/workflows",
    ]) {
      const abs = path.join(root, dir);
      if (fs.existsSync(abs)) {
        fs.rmSync(abs, { recursive: true, force: true });
      }
    }
  }

  const esmConfig = mainEsmConfig({ production: isProd, watch: isWatch });

  // Config for CJS file (Preload)
  const cjsConfig = {
    ...commonOptions({ production: isProd }),
    entryPoints: [MAIN_PRELOAD_ENTRY],
    outdir: "dist-electron/electron",
    format: "cjs",
    outExtension: { ".js": ".cjs" },
  };

  const guestConfigs = CORE_PICKER_GUEST_ASSETS.map((asset) =>
    guestRuntimeBuildConfig(asset, { minify: isProd, absWorkingDir: root })
  );

  const sdkConfig = pluginSdkRuntimeBuildConfig({ minify: isProd, absWorkingDir: root });

  const startBuild = async () => {
    if (isWatch) {
      // Every guest bundle gets its own watch context, so editing a guest's
      // source rebuilds its asset in place. All of them gate the ready marker
      // `npm run dev` waits on before it starts Electron.
      await startWatchBuild({
        configs: {
          main: esmConfig,
          preload: cjsConfig,
          sdk: sdkConfig,
          ...Object.fromEntries(
            CORE_PICKER_GUEST_ASSETS.map((asset, index) => [`guest:${asset.id}`, guestConfigs[index]])
          ),
        },
        readyFile: buildReadyFile,
        copyAssets: () => {
          // Armed before its first sync, so an edit made while that runs is
          // not lost, and synced before the gate can publish `.build-ready.js`.
          // The first sync is rechecked like any later pass, which covers an
          // edit made since the startup gates ran.
          watchPluginAssets({
            srcRoot: PLUGIN_SRC_ROOT,
            destRoot: PLUGIN_DIST_ROOT,
            initialSync: true,
            onChange: recheckSyncedPluginAssets,
          });
        },
        onFirstReady: () => {
          validateCopiedPluginAssets();
          validateGuestAssets();
          console.log("[Build] Initial build ready.");
        },
        createContext: context,
      });
      console.log("[Build] Watching for changes...");
    } else {
      await Promise.all([
        build(esmConfig),
        build(cjsConfig),
        build(sdkConfig),
        ...guestConfigs.map(build),
      ]);
      writeBuildInfo();
      syncAllPluginAssets();
      validateCopiedPluginAssets();
      validateGuestAssets();
      writeBuildReadyMarker(buildReadyFile);
      console.log("[Build] Complete.");
    }
  };

  try {
    await runWithCanopyModel({ watch: isWatch, prepare: prepareCanopyReaderModel, startBuild });
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
