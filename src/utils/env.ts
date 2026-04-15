type DaintreeEnvKey =
  | "DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS"
  | "DAINTREE_PERF_CAPTURE"
  | "DAINTREE_VERBOSE";

type ProcessLike = {
  env?: Record<string, string | undefined>;
};

function getProcessEnv(): Record<string, string | undefined> | undefined {
  const maybeProcess = (globalThis as { process?: ProcessLike }).process;
  return maybeProcess?.env;
}

// Some Daintree env keys are set at Electron launch time (not Vite build time)
// and cannot reach the sandboxed renderer through `import.meta.env` or
// `process.env`. For those keys, `electron/preload.cts` exposes the value on
// `window` via `contextBridge`, and we consult that bridge first. Other keys
// remain build-time only (dev-workflow flags baked by Vite).
function getRuntimeBridgeValue(key: DaintreeEnvKey): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (key === "DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS") {
    return window.__DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__ === true ? "1" : undefined;
  }
  return undefined;
}

const warnedLegacyKeys = new Set<string>();

function legacyCanopyKey(key: DaintreeEnvKey): string {
  return key.replace(/^DAINTREE_/, "CANOPY_");
}

function readLegacyFallback(key: DaintreeEnvKey): string | undefined {
  const legacy = legacyCanopyKey(key);
  const viteLegacy = (import.meta.env as Record<string, string | undefined>)[legacy];
  if (typeof viteLegacy === "string") {
    if (!warnedLegacyKeys.has(legacy)) {
      warnedLegacyKeys.add(legacy);
      // eslint-disable-next-line no-console
      console.warn(`[daintree] env var ${legacy} is deprecated; use ${key} instead.`);
    }
    return viteLegacy;
  }
  const processLegacy = getProcessEnv()?.[legacy];
  if (typeof processLegacy === "string") {
    if (!warnedLegacyKeys.has(legacy)) {
      warnedLegacyKeys.add(legacy);
      // eslint-disable-next-line no-console
      console.warn(`[daintree] env var ${legacy} is deprecated; use ${key} instead.`);
    }
    return processLegacy;
  }
  return undefined;
}

export function getDaintreeEnv(key: DaintreeEnvKey): string | undefined {
  const runtimeValue = getRuntimeBridgeValue(key);
  if (runtimeValue !== undefined) {
    return runtimeValue;
  }

  const viteValue = import.meta.env[key];
  if (typeof viteValue === "string") {
    return viteValue;
  }

  const processValue = getProcessEnv()?.[key];
  if (typeof processValue === "string") {
    return processValue;
  }

  return readLegacyFallback(key);
}

export function isDaintreeEnvEnabled(key: DaintreeEnvKey): boolean {
  return getDaintreeEnv(key) === "1";
}
