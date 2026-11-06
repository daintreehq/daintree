export type PtyIntegration<T> =
  { available: true; modules: T } | { available: false; reason: string };

export interface LoadPtyIntegrationOptions {
  /** Defaults to `Boolean(process.env.CI)`: CI builds node-pty, so a skip there hides a broken build. */
  ci?: boolean;
  loadNativePty?: () => Promise<unknown>;
}

// node-pty's `loadNativeModule` wraps every addon load failure (missing build, wrong ABI,
// dlopen error) in this message. Anything else thrown while importing it is not a
// missing capability and must fail the suite.
const NATIVE_ADDON_LOAD_FAILURE = /^Failed to load native module: [\w-]+\.node, checked: /;

export function isNativeAddonLoadFailure(error: unknown): error is Error {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && NATIVE_ADDON_LOAD_FAILURE.test(message);
}

/**
 * Probes node-pty, then loads the suite's modules outside any catch, so an error in the
 * production import graph or a test helper fails the suite instead of skipping it. Only an
 * unloadable node-pty addon off CI yields `available: false`.
 */
export async function loadPtyIntegration<T>(
  loadModules: () => Promise<T>,
  options: LoadPtyIntegrationOptions = {}
): Promise<PtyIntegration<T>> {
  const ci = options.ci ?? Boolean(process.env.CI);
  const loadNativePty = options.loadNativePty ?? (() => import("node-pty"));

  try {
    await loadNativePty();
  } catch (error) {
    if (!isNativeAddonLoadFailure(error)) throw error;
    if (ci) {
      const message = `node-pty native addon is required on CI but failed to load: ${error.message}`;
      throw new Error(message, { cause: error });
    }
    const reason = `node-pty native addon could not be loaded under Node ${process.version}: ${error.message}`;
    console.warn(`Skipping PTY integration suite: ${reason}`);
    return { available: false, reason };
  }

  return { available: true, modules: await loadModules() };
}
