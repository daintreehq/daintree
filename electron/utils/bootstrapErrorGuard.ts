// Installs early `uncaughtException` / `unhandledRejection` handlers in a
// utility process BEFORE its host module is dynamically imported. A native-load
// failure during `await import("./<host>.js")` (arch mismatch, bad rebuild,
// missing runtime) would otherwise surface as an unhandled rejection — and
// since Electron 37 utility processes only WARN on unhandled rejections instead
// of crashing. The process then stays alive without ever posting `ready`, so
// the parent's `waitForReady()` hangs forever. These handlers convert that
// silent hang into a fast, observable exit: the parent's `exit` listener
// rejects `waitForReady()` and the posted error event aids log triage.
//
// Kept dependency-free on purpose: the whole point is to be in place before the
// import phase that may fail, so this module must not pull in anything that
// could itself fail to load.

interface BootstrapErrorGuardOptions {
  /** Stderr log prefix, e.g. "[PtyHostBootstrap]". */
  label: string;
  /**
   * Posts a typed error event to the parent before exit. Implemented by the
   * caller because the event shape differs per host (PTY carries an `id`).
   * Failures here are swallowed — the exit proceeds regardless.
   */
  postError: (message: string) => void;
}

function serializeReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? reason.message;
  }
  return String(reason);
}

/**
 * Returns a cleanup function that removes the installed handlers. Call it once
 * the host module has been imported successfully: the host installs its own
 * lifetime handlers during evaluation, so leaving the bootstrap guard in place
 * would double-report every post-startup crash (once with a misleading
 * `[…Bootstrap]` label).
 */
export function installBootstrapErrorGuard(options: BootstrapErrorGuardOptions): () => void {
  const { label, postError } = options;
  let exiting = false;

  const reportAndExit = (kind: string, reason: unknown): void => {
    if (exiting) return;
    exiting = true;
    console.error(`${label} ${kind}:`, reason);
    try {
      postError(serializeReason(reason));
    } catch {
      // ignore — the parent still learns of the failure via the exit event
    }
    // Exit on next tick so Mojo IPC can flush the error event before the process
    // dies; the parent's exit handler then rejects waitForReady() and supervises
    // a restart. Mirrors the setImmediate idiom in pty-host.ts / workspace-host.ts.
    setImmediate(() => process.exit(1));
  };

  const onUncaught = (err: unknown): void => reportAndExit("Uncaught Exception", err);
  const onRejection = (reason: unknown): void => reportAndExit("Unhandled Rejection", reason);

  process.on("uncaughtException", onUncaught as NodeJS.UncaughtExceptionListener);
  process.on("unhandledRejection", onRejection as NodeJS.UnhandledRejectionListener);

  return () => {
    process.off("uncaughtException", onUncaught as NodeJS.UncaughtExceptionListener);
    process.off("unhandledRejection", onRejection as NodeJS.UnhandledRejectionListener);
  };
}
