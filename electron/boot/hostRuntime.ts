// The Host runtime's start order, kept free of Electron and service imports so
// the ordering and idempotency are testable on their own. The real steps are
// wired in hostBootstrap.ts.

export interface HostRuntimeSteps {
  /** Store migrations and the global deferred-task registration. */
  initGlobalServices(): Promise<"ok" | "exit-requested">;
  /** Construct the critical services (the PtyClient, fork deferred) and register IPC. */
  prepareServices(): void;
  /** PATH refresh, then the pty-host fork; resolves once the host is ready. */
  startPtyHost(): Promise<void>;
  startWorkspaceHostPool(): Promise<void>;
  startMcp(): Promise<void>;
  startPluginHost(): Promise<void>;
  startPowerPolicy(): void;
  /** Run the rest of the deferred queue, which no renderer will release. */
  releaseDeferredTasks(): void;
}

export type HostRuntimeResult = "ok" | "exit-requested";

export interface HostRuntime {
  start(): Promise<HostRuntimeResult>;
  isStarted(): boolean;
}

/**
 * Bring the backend up with no window, in the order the services depend on
 * each other. `start()` runs once; every later call resolves with the first
 * run's result.
 */
export function createHostRuntime(steps: HostRuntimeSteps): HostRuntime {
  let run: Promise<HostRuntimeResult> | null = null;
  let started = false;

  async function execute(): Promise<HostRuntimeResult> {
    if ((await steps.initGlobalServices()) === "exit-requested") return "exit-requested";
    steps.prepareServices();
    await steps.startPtyHost();
    await steps.startWorkspaceHostPool();
    await steps.startMcp();
    await steps.startPluginHost();
    steps.startPowerPolicy();
    steps.releaseDeferredTasks();
    started = true;
    return "ok";
  }

  return {
    start() {
      // A failed run is forgotten so a later request can try again.
      run ??= execute().catch((err: unknown) => {
        run = null;
        throw err;
      });
      return run;
    },
    isStarted: () => started,
  };
}
