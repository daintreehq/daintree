// Lightweight runtime flags derived from process-level Electron signals /
// `process.argv`.
// Kept separate from the heavy `environment.ts` (which runs `app.getPath`/
// `setPath`, fs, and SQLite work at module load) so importers that only need a
// flag — e.g. `ProjectViewManager` reading `isDemoMode` — don't pull that
// startup machinery into their graph. Same rationale as `deepLinkUrlQueue.ts`.

const isElectronProcess = process.versions.electron !== undefined;
const isPackaged = isElectronProcess && process.defaultApp !== true;

export const isDemoMode = !isPackaged && process.argv.includes("--demo-mode");
export const isSmokeTest = process.argv.includes("--smoke-test");
export const E2E_MODE_ARG = "--daintree-e2e-mode";
export const E2E_SKIP_FIRST_RUN_DIALOGS_ARG = "--daintree-e2e-skip-first-run-dialogs";
export const E2E_FAULT_MODE_ARG = "--daintree-e2e-fault-mode";
export const E2E_DEFER_RENDERER_LOAD_ARG = "--daintree-e2e-defer-renderer-load";
export const E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE_ARG =
  "--daintree-e2e-disable-cached-view-cpu-throttle";
export const E2E_CRASH_DUMPS_DIR_ARG = "--daintree-e2e-crash-dumps-dir=";
export const E2E_SIDELOAD_PLUGIN_DIR_ARG = "--daintree-e2e-sideload-plugin-dir=";

function hasArg(flag: string): boolean {
  return process.argv.includes(flag);
}

function getArgValue(prefix: string): string | undefined {
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  const value = arg?.slice(prefix.length);
  return value && value.trim().length > 0 ? value : undefined;
}

export function getIsE2EMode(): boolean {
  return !isPackaged && (process.env.DAINTREE_E2E_MODE === "1" || hasArg(E2E_MODE_ARG));
}

export function getIsE2ESkipFirstRunDialogs(): boolean {
  return (
    !isPackaged &&
    (process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS === "1" ||
      hasArg(E2E_SKIP_FIRST_RUN_DIALOGS_ARG))
  );
}

export function getIsE2EFaultMode(): boolean {
  return !isPackaged && (process.env.DAINTREE_E2E_FAULT_MODE === "1" || hasArg(E2E_FAULT_MODE_ARG));
}

export function getIsE2EDeferRendererLoad(): boolean {
  return (
    !isPackaged &&
    (process.env.DAINTREE_E2E_DEFER_RENDERER_LOAD === "1" || hasArg(E2E_DEFER_RENDERER_LOAD_ARG))
  );
}

export function getIsE2EDisableCachedViewCpuThrottle(): boolean {
  return (
    !isPackaged &&
    (process.env.DAINTREE_E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE === "1" ||
      hasArg(E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE_ARG))
  );
}

export function getE2ECrashDumpsDir(): string | undefined {
  return !isPackaged && process.env.DAINTREE_E2E_CRASH_DUMPS_DIR
    ? process.env.DAINTREE_E2E_CRASH_DUMPS_DIR
    : !isPackaged
      ? getArgValue(E2E_CRASH_DUMPS_DIR_ARG)
      : undefined;
}

export function getE2ESideloadPluginDir(): string | undefined {
  return !isPackaged && process.env.DAINTREE_E2E_SIDELOAD_PLUGIN_DIR
    ? process.env.DAINTREE_E2E_SIDELOAD_PLUGIN_DIR
    : !isPackaged
      ? getArgValue(E2E_SIDELOAD_PLUGIN_DIR_ARG)
      : undefined;
}

export const isE2EMode = getIsE2EMode();
export const isE2ESkipFirstRunDialogs = getIsE2ESkipFirstRunDialogs();
export const isE2EFaultMode = getIsE2EFaultMode();
export const isE2EDeferRendererLoad = getIsE2EDeferRendererLoad();
export const isE2EDisableCachedViewCpuThrottle = getIsE2EDisableCachedViewCpuThrottle();
export const e2eCrashDumpsDir = getE2ECrashDumpsDir();
export const e2eSideloadPluginDir = getE2ESideloadPluginDir();
export const smokeTestStart = isSmokeTest ? Date.now() : 0;
