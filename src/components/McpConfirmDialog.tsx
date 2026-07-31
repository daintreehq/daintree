import { useCallback, useEffect, useRef } from "react";
import type { McpConfirmationDecision } from "@shared/types/ipc/mcpServer";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
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
 * Lower-bound read-time gate for destructive dispatches. `resolveOnce` guards
 * the second click; this disables the primary button briefly after each item
 * is promoted so a click meant for the previous modal can't silently approve a
 * freshly-promoted destructive write before the user has read it.
 */
const CONFIRM_COOLDOWN_MS = 1_200;

/**
 * Upper bound for the user-agent shown in the "Requested by" row. An external
 * client controls its own `User-Agent` header (capped at Node's ~8 KB header
 * limit, not at a sane length), so clamp the display value here so an oversized
 * string can't push the Arguments block and confirm button below the fold.
 */
const MAX_USER_AGENT_DISPLAY = 120;

function truncateUserAgent(userAgent: string): string {
  return userAgent.length > MAX_USER_AGENT_DISPLAY
    ? `${userAgent.slice(0, MAX_USER_AGENT_DISPLAY - 1)}…`
    : userAgent;
}

/**
 * Singleton dialog driven by the MCP confirmation queue. Mounted once near
 * the top of `App.tsx`. Reads `current` from `useMcpConfirmStore` and
 * surfaces one `ConfirmDialog` at a time — concurrent agent calls queue
 * FIFO behind the visible modal rather than stacking overlapping dialogs.
 */
export function McpConfirmDialog() {
  const current = useMcpConfirmStore((state) => state.current);
  const resolveCurrent = useMcpConfirmStore((state) => state.resolveCurrent);
  const resetKey = current?.requestId ?? "null";

  // `resolveCurrent` is synchronous: it resolves the promise and advances the
  // queue so `current` becomes the next item before React re-renders. A rapid
  // double-click would otherwise fire a second `resolveCurrent("approved")`
  // that lands on the freshly-promoted queued item — silently approving a
  // destructive action the user never saw. Gate every resolution on the
  // requestId we've already handled so a given dialog can resolve exactly once.
  const handledRequestIdRef = useRef<string | null>(null);
  const resolveOnce = useCallback(
    (requestId: string, decision: McpConfirmationDecision) => {
      if (handledRequestIdRef.current === requestId) return;
      handledRequestIdRef.current = requestId;
      resolveCurrent(decision);
    },
    [resolveCurrent]
  );

  useEffect(() => {
    if (current === null) return;
    const { requestId, enqueuedAt } = current;
    // Subtract time the request already spent queued behind a prior modal so
    // every dispatch races against the same wall-clock budget; otherwise a
    // queued item could outlive main's 30s deadline and degrade to a generic
    // timeout error instead of `CONFIRMATION_TIMEOUT`.
    const elapsed = Date.now() - enqueuedAt;
    // Destructive dispatches disable the confirm button for CONFIRM_COOLDOWN_MS
    // after promotion. A deeply-queued item could otherwise have less budget
    // left than the cooldown and auto-time-out before the user can ever click —
    // so floor the window above the cooldown for those. The floor still lands
    // under main's 30s deadline (28s budget + ~1.5s), preserving the clean
    // CONFIRMATION_TIMEOUT outcome.
    const floor = current.danger === "confirm" ? CONFIRM_COOLDOWN_MS + 300 : 500;
    const remaining = Math.max(floor, CONFIRMATION_TIMEOUT_MS - elapsed);
    const timer = setTimeout(() => {
      resolveOnce(requestId, "timeout");
    }, remaining);
    return () => clearTimeout(timer);
  }, [current, resolveOnce]);

  if (current === null) {
    return (
      <ErrorBoundary variant="component" componentName="McpConfirmDialog" resetKeys={[resetKey]}>
        <ConfirmDialog
          isOpen={false}
          title=""
          confirmLabel="Run"
          onConfirm={() => {}}
          variant="default"
        />
      </ErrorBoundary>
    );
  }

  // Severity follows the action's registry classification, not the fact that
  // an MCP client dispatched it; only genuinely destructive dispatches earn
  // red. Provenance differs by dispatch origin: pinned help-session dispatch
  // is the assistant's own panel, so `callerInfo` is absent and the dialog
  // stays provenance-free. Unpinned external/api-key dispatch carries the
  // requesting bearer's identity (#9157), surfaced in a "Requested by" row so
  // the user can see which client is asking before approving.
  const isDestructive = current.danger === "confirm";
  const variant = isDestructive ? "destructive" : "default";
  const callerInfo = current.callerInfo;

  return (
    <ErrorBoundary variant="component" componentName="McpConfirmDialog" resetKeys={[resetKey]}>
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveOnce(current.requestId, "rejected")}
        title={`Run '${current.actionTitle}'?`}
        description={current.actionDescription}
        confirmLabel={current.actionTitle}
        cancelLabel="Cancel"
        onConfirm={() => resolveOnce(current.requestId, "approved")}
        variant={variant}
        confirmDisabled={Boolean(current.previewPending)}
        confirmCooldownMs={isDestructive ? CONFIRM_COOLDOWN_MS : undefined}
        cooldownKey={current.requestId}
      >
        <div className="space-y-3">
          {callerInfo && (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
                Requested by
              </div>
              <div className="text-xs text-daintree-text/80 break-words">
                …{callerInfo.token4LastChars} · {truncateUserAgent(callerInfo.userAgent)}
              </div>
            </div>
          )}
          {current.dangerRationale && (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
                Why this is gated
              </div>
              <div className="text-xs text-daintree-text/80 break-words">
                {current.dangerRationale}
              </div>
            </div>
          )}
          {(current.previewPending || (current.preview && current.preview.length > 0)) && (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
                {current.previewTitle ?? "Working tree changes"}
              </div>
              {current.previewPending ? (
                <div className="text-xs text-daintree-text/60">Checking current changes…</div>
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-overlay-subtle rounded px-2 py-1.5 text-daintree-text/80">
                  {current.preview?.join("\n")}
                </pre>
              )}
            </div>
          )}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
              Arguments
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-overlay-subtle rounded px-2 py-1.5 text-daintree-text/80">
              {current.argsSummary || "(none)"}
            </pre>
          </div>
        </div>
      </ConfirmDialog>
    </ErrorBoundary>
  );
}
