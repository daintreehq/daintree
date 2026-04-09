type CanopyEnvKey = "CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS" | "CANOPY_PERF_CAPTURE" | "CANOPY_VERBOSE";

type ProcessLike = {
  env?: Record<string, string | undefined>;
};

function getProcessEnv(): Record<string, string | undefined> | undefined {
  const maybeProcess = (globalThis as { process?: ProcessLike }).process;
  return maybeProcess?.env;
}

// Some Canopy env keys are set at Electron launch time (not Vite build time)
// and cannot reach the sandboxed renderer through `import.meta.env` or
// `process.env`. For those keys, `electron/preload.cts` exposes the value on
// `window` via `contextBridge`, and we consult that bridge first. Other keys
// remain build-time only (dev-workflow flags baked by Vite).
function getRuntimeBridgeValue(key: CanopyEnvKey): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (key === "CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS") {
    return window.__CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS__ === true ? "1" : undefined;
  }
  return undefined;
}

export function getCanopyEnv(key: CanopyEnvKey): string | undefined {
  const runtimeValue = getRuntimeBridgeValue(key);
  if (runtimeValue !== undefined) {
    return runtimeValue;
  }

  const viteValue = import.meta.env[key];
  if (typeof viteValue === "string") {
    return viteValue;
  }

  return getProcessEnv()?.[key];
}

export function isCanopyEnvEnabled(key: CanopyEnvKey): boolean {
  return getCanopyEnv(key) === "1";
}
