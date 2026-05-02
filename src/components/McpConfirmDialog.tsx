import { useEffect } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useMcpConfirmStore } from "@/store/mcpConfirmStore";

/**
 * Renderer-side timer that beats main's 30s `pendingDispatches` deadline by
 * a couple seconds, so the user-facing modal closes with a clean
 * `CONFIRMATION_TIMEOUT` outcome before main rejects with a generic
 * "Action dispatch timed out" error. The modal disappears automatically
 * either way; the earlier window just produces nicer audit semantics.
 */
const CONFIRMATION_TIMEOUT_MS = 28_000;

/**
 * Singleton dialog driven by the MCP confirmation queue. Mounted once near
 * the top of `App.tsx`. Reads `current` from `useMcpConfirmStore` and
 * surfaces one `ConfirmDialog` at a time — concurrent agent calls queue
 * FIFO behind the visible modal rather than stacking overlapping dialogs.
 */
export function McpConfirmDialog() {
  const current = useMcpConfirmStore((state) => state.current);
  const resolveCurrent = useMcpConfirmStore((state) => state.resolveCurrent);

  useEffect(() => {
    if (current === null) return;
    // Subtract time the request already spent queued behind a prior modal so
    // every dispatch races against the same wall-clock budget; otherwise a
    // queued item could outlive main's 30s deadline and degrade to a generic
    // timeout error instead of `CONFIRMATION_TIMEOUT`.
    const elapsed = Date.now() - current.enqueuedAt;
    const remaining = Math.max(500, CONFIRMATION_TIMEOUT_MS - elapsed);
    const timer = setTimeout(() => {
      resolveCurrent("timeout");
    }, remaining);
    return () => clearTimeout(timer);
  }, [current, resolveCurrent]);

  if (current === null) {
    return (
      <ConfirmDialog
        isOpen={false}
        title=""
        confirmLabel="Run action"
        onConfirm={() => {}}
        variant="destructive"
      />
    );
  }

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveCurrent("rejected")}
      title={`Run '${current.actionTitle}'?`}
      description={current.actionDescription}
      confirmLabel="Run action"
      cancelLabel="Cancel"
      onConfirm={() => resolveCurrent("approved")}
      variant="destructive"
    >
      <div className="space-y-2">
        <div className="text-xs text-daintree-text/60 uppercase tracking-wide">Arguments</div>
        <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-overlay-subtle rounded px-2 py-1.5 text-daintree-text/80">
          {current.argsSummary || "(none)"}
        </pre>
      </div>
    </ConfirmDialog>
  );
}
