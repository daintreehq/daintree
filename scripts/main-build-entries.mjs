import fs from "fs";
import path from "path";
import { MAIN_BUNDLE_EXTERNAL } from "./lib/main-bundle.mjs";

/**
 * The main-process build's inputs, shared by scripts/build-main.mjs and the
 * Remote Hosts tree-shake test so the test checks exactly what ships.
 */

/** Packages the main bundle leaves to Node's resolver at runtime. */
export const MAIN_EXTERNAL = MAIN_BUNDLE_EXTERNAL;

/** ESM entries that are not discovered from the plugin directories. */
export const MAIN_STATIC_ESM_ENTRIES = [
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
  // VAD side-chain for OpenAI transcription (#9177). Forked as a
  // utilityProcess by openaiVadProcess (#12577); needs its own entry so
  // esbuild emits a standalone bundle at the resolved path.
  "electron/services/voice/openaiVadWorker.ts",
  // Multi-threading workers: per-terminal analysis (headless xterm +
  // activity detection) inside pty-host, SQLite maintenance off the main
  // event loop, and copytree generation inside workspace-host. Each is
  // loaded via `new Worker()` and needs a standalone bundle at its
  // resolved worker path.
  "electron/pty-host/analysisWorker.ts",
  "electron/services/persistence/dbMaintenanceWorker.ts",
  "electron/workspace-host/copytreeWorker.ts",
  // Agent reads of a plugin's database (#12845): one utilityProcess per
  // call, so a runaway query can be killed without touching main.
  "electron/services/pluginAgentMcp/databaseQueryWorker.ts",
];

export const MAIN_PRELOAD_ENTRY = "electron/preload.cts";

function discoverPluginMainEntries(rootDir, tier) {
  const pluginsRoot = path.join(rootDir, "plugins", tier);
  if (!fs.existsSync(pluginsRoot)) return [];
  return fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `plugins/${tier}/${entry.name}/main/index.ts`)
    .filter((rel) => fs.existsSync(path.join(rootDir, rel)));
}

/**
 * Discover each built-in plugin's main entry (`plugins/builtin/<name>/main/index.ts`)
 * so adding a new built-in plugin needs no build-config edit. Mirrors
 * `copyBuiltInPluginManifests`, which auto-discovers the same directories.
 */
export function discoverBuiltInPluginMainEntries(rootDir) {
  return discoverPluginMainEntries(rootDir, "builtin");
}

/**
 * Discover each sample plugin's main entry (`plugins/sample/<name>/main/index.ts`)
 * so adding a new sample plugin needs no build-config edit. Mirrors
 * `discoverBuiltInPluginMainEntries` and `copySamplePluginManifests`. A
 * manifest-only sample dir (no `main/index.ts`) is skipped here but still has its
 * manifest validated and copied by the manifest steps.
 */
export function discoverSamplePluginMainEntries(rootDir) {
  return discoverPluginMainEntries(rootDir, "sample");
}

/**
 * Every ESM entry of the main build: hosts, workers, built-in plugins, and the
 * sample plugins compiled for the host-contract e2e harness (#9286, #9592),
 * which are sideloaded via `DAINTREE_E2E_SIDELOAD_PLUGIN_DIR` and absent in
 * prod because no `pluginsRoot` defaults to their directory.
 */
export function mainEsmEntryPoints(rootDir) {
  return [
    ...MAIN_STATIC_ESM_ENTRIES,
    ...discoverBuiltInPluginMainEntries(rootDir),
    ...discoverSamplePluginMainEntries(rootDir),
  ];
}
