type CanopyEnvKey = "CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS" | "CANOPY_PERF_CAPTURE" | "CANOPY_VERBOSE";

type ProcessLike = {
  env?: Record<string, string | undefined>;
};

function getProcessEnv(): Record<string, string | undefined> | undefined {
  const maybeProcess = (globalThis as { process?: ProcessLike }).process;
  return maybeProcess?.env;
}

export function getCanopyEnv(key: CanopyEnvKey): string | undefined {
  const viteValue = import.meta.env[key];
  if (typeof viteValue === "string") {
    return viteValue;
  }

  return getProcessEnv()?.[key];
}

export function isCanopyEnvEnabled(key: CanopyEnvKey): boolean {
  return getCanopyEnv(key) === "1";
}
