import type { FdLeakWarningPayload } from "@shared/types/pty-host";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { logWarn } from "@/utils/logger";

let lastWarningTimestamp = 0;
const REARM_MS = 5 * 60 * 1000; // 5 min cooldown before logging again

export function _resetFdLeakWarningCooldown() {
  lastWarningTimestamp = 0;
}

function formatFdLeakWarning(data: FdLeakWarningPayload): string {
  const fdPct =
    data.ptmxLimit != null && data.ptmxLimit > 0
      ? ` (${Math.round((data.fdCount / data.ptmxLimit) * 100)}% of limit)`
      : "";

  const orphanedPids =
    data.orphanedPids.length > 0 ? `, orphaned PIDs: ${data.orphanedPids.join(", ")}` : "";

  return (
    `[TerminalDiagnostics] FD leak warning: ${data.fdCount} open file descriptors, ` +
    `${data.activeTerminals} active terminals, ~${data.estimatedLeaked} leaked${fdPct}` +
    `${orphanedPids}.`
  );
}

export function setupFdLeakWarningListeners(): DisposableStore {
  const d = new DisposableStore();

  d.add(
    toDisposable(
      window.electron.terminal.onFdLeakWarning((data: FdLeakWarningPayload) => {
        const now = Date.now();
        if (now - lastWarningTimestamp < REARM_MS) return;
        lastWarningTimestamp = now;

        logWarn(formatFdLeakWarning(data), { data });
      })
    )
  );

  return d;
}
