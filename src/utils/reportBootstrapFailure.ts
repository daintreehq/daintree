import { renderBootstrapError } from "./renderBootstrapError";

/**
 * The last stop for a renderer that failed to boot, shared by the entry
 * (`src/main.tsx`) and the project window's shell: report it every way still
 * available, then replace the startup skeleton with the bootstrap-error screen.
 */
export function reportBootstrapFailure(error: unknown): void {
  // Logger may not be initialized at this stage of bootstrap; console is the
  // last-resort sink before the bootstrap-error UI takes over.
  // eslint-disable-next-line no-console
  console.error("Bootstrap failed:", error);

  void (async () => {
    try {
      const { captureException } = await import("@sentry/electron/renderer");
      captureException(error);
    } catch {
      // Sentry may not have initialized yet
    }
  })();

  try {
    const errObj =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
    void window.electron?.logs?.write("error", `Bootstrap failed: ${JSON.stringify(errObj)}`);
  } catch {
    // IPC may not be available
  }

  document.getElementById("startup-skeleton")?.remove();

  const rootEl = document.getElementById("root");
  if (rootEl) {
    renderBootstrapError(rootEl, error);
  }
}
