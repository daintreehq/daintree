import { useCallback, useRef } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePluginConfirmStore, type PluginConfirmationDecision } from "@/store/pluginConfirmStore";

/**
 * Lower-bound read-time gate for destructive dispatches. `resolveOnce` guards
 * the second click; this disables the primary button briefly after each item
 * is promoted so a click meant for the previous modal can't silently approve a
 * freshly-promoted destructive write before the user has read it.
 */
const CONFIRM_COOLDOWN_MS = 1_200;

/**
 * Singleton dialog driven by the plugin-action confirmation queue. Mounted
 * once near the top of `App.tsx`, sibling to `McpConfirmDialog`. Reads
 * `current` from `usePluginConfirmStore` and surfaces one `ConfirmDialog`
 * at a time — concurrent dispatches queue FIFO behind the visible modal
 * rather than stacking overlapping dialogs.
 *
 * Unlike the MCP dialog there is no auto-timeout: plugin dispatch has no
 * main-process deadline racing the modal, so it stays open until the user
 * decides (or `usePluginActions` unmounts and drops the request).
 */
export function PluginConfirmDialog() {
  const current = usePluginConfirmStore((state) => state.current);
  const resolveCurrent = usePluginConfirmStore((state) => state.resolveCurrent);
  const resetKey = current?.requestId ?? "null";

  // `resolveCurrent` is synchronous: it resolves the promise and advances the
  // queue so `current` becomes the next item before React re-renders. A rapid
  // double-click would otherwise fire a second `resolveCurrent("approved")`
  // that lands on the freshly-promoted queued item — silently approving an
  // action the user never saw. Gate every resolution on the requestId we've
  // already handled so a given dialog can resolve exactly once.
  const handledRequestIdRef = useRef<string | null>(null);
  const resolveOnce = useCallback(
    (requestId: string, decision: PluginConfirmationDecision) => {
      if (handledRequestIdRef.current === requestId) return;
      handledRequestIdRef.current = requestId;
      resolveCurrent(decision);
    },
    [resolveCurrent]
  );

  if (current === null) {
    return (
      <ErrorBoundary variant="component" componentName="PluginConfirmDialog" resetKeys={[resetKey]}>
        <ConfirmDialog
          isOpen={false}
          title=""
          confirmLabel="Run"
          onConfirm={() => {}}
          variant="destructive"
        />
      </ErrorBoundary>
    );
  }

  const isDestructive = current.effectiveDanger === "confirm";
  const variant = isDestructive ? "destructive" : "default";
  // A no-argument action has nothing to preview, so the whole block is
  // dropped rather than shown holding a placeholder — matching
  // PluginMcpConfirmDialog. The description above already says what runs.
  const hasArgs = current.argsSummary.length > 0;

  return (
    <ErrorBoundary variant="component" componentName="PluginConfirmDialog" resetKeys={[resetKey]}>
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveOnce(current.requestId, "rejected")}
        title={`Run '${current.actionTitle}'?`}
        description={
          current.actionDescription.trim() ||
          `Action contributed by the '${current.pluginId}' plugin.`
        }
        confirmLabel={current.actionTitle}
        cancelLabel="Cancel"
        onConfirm={() => resolveOnce(current.requestId, "approved")}
        variant={variant}
        confirmCooldownMs={isDestructive ? CONFIRM_COOLDOWN_MS : undefined}
        cooldownKey={current.requestId}
      >
        {hasArgs ? (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
              Arguments
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-overlay-subtle rounded px-2 py-1.5 text-daintree-text/80">
              {current.argsSummary}
            </pre>
          </div>
        ) : null}
      </ConfirmDialog>
    </ErrorBoundary>
  );
}
