import { useCallback, useRef } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePluginConfirmStore, type PluginConfirmationDecision } from "@/store/pluginConfirmStore";

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

  return (
    <ErrorBoundary variant="component" componentName="PluginConfirmDialog" resetKeys={[resetKey]}>
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveOnce(current.requestId, "rejected")}
        title={`Run '${current.actionTitle}'?`}
        description={
          current.actionDescription ||
          `This action is contributed by the '${current.pluginId}' plugin.`
        }
        confirmLabel={current.actionTitle}
        cancelLabel="Cancel"
        onConfirm={() => resolveOnce(current.requestId, "approved")}
        variant="destructive"
      />
    </ErrorBoundary>
  );
}
