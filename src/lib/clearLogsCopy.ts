import { notify } from "@/lib/notify";

// `logs.clear` is dispatched from two surfaces (Troubleshooting settings and the
// Diagnostics dock). The copy lives here so both confirmations say the same thing.
// The <ConfirmDialog> and the "logs.clear" dispatch stay at each call site — the
// confirm-wiring guard requires them co-located in the same source file.

export const CLEAR_LOGS_TITLE = "Clear logs?";

// Names the real consequence: DiagnosticsCollector builds its report from the
// in-memory buffer, so clearing costs the evidence a bug report would carry.
// The on-disk log file is written separately and survives.
export const CLEAR_LOGS_DESCRIPTION =
  "Empties the log view and the in-memory buffer that diagnostic reports are built from. The log file on disk keeps a copy.";

export const CLEAR_LOGS_CONFIRM_LABEL = "Clear logs";

/**
 * Surfaces a failed clear in the owning surface. `onRetry` must reopen the
 * confirmation — re-dispatching straight from the toast would bypass the D1 gate.
 */
export function notifyClearLogsFailed(onRetry: () => void): void {
  notify({
    type: "error",
    title: "Couldn't clear logs",
    message: "The logs are still here. Open the log file if you need the details.",
    actions: [{ label: "Try again", variant: "primary", onClick: onRetry }],
    context: { eventKind: "uiFeedback" },
  });
}
