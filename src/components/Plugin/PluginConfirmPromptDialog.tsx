import { useCallback, useRef } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePluginPromptStore } from "@/store/pluginPromptStore";

/**
 * Singleton dialog for `host.showConfirm` (#10522). Mounted once near the top of
 * `App.tsx`, sibling to `PluginConfirmDialog`. Renders the front prompt of
 * `pluginPromptStore` when it is a `confirm`, surfacing one `ConfirmDialog` at a
 * time — concurrent prompts queue FIFO behind the visible dialog.
 *
 * Distinct from `PluginConfirmDialog`, which gates destructive *action
 * dispatches*; this is a plugin imperatively asking the user a yes/no question
 * mid-command.
 */
export function PluginConfirmPromptDialog() {
  const current = usePluginPromptStore((state) => state.current);
  const resolveCurrent = usePluginPromptStore((state) => state.resolveCurrent);

  // Capture the narrowed confirm `params` into a fresh object: `PendingUiPrompt`
  // is a struct whose `.params` is the union, so narrowing the discriminant on
  // the access expression doesn't carry through a stored reference to the whole
  // item — the object literal pins the narrowed `options` type.
  const confirm =
    current && current.params.kind === "confirm"
      ? { promptId: current.promptId, pluginId: current.pluginId, options: current.params.options }
      : null;
  const resetKey = confirm ? confirm.promptId : "null";

  // resolveCurrent advances the queue synchronously, so a rapid double-click
  // could land a second resolution on the freshly-promoted item. Gate each
  // dialog to resolve exactly once by the promptId we've already handled.
  const handledPromptIdRef = useRef<string | null>(null);
  const resolveOnce = useCallback(
    (promptId: string, value: boolean) => {
      if (handledPromptIdRef.current === promptId) return;
      handledPromptIdRef.current = promptId;
      resolveCurrent(value);
    },
    [resolveCurrent]
  );

  if (!confirm) {
    return (
      <ErrorBoundary
        variant="component"
        componentName="PluginConfirmPromptDialog"
        resetKeys={[resetKey]}
      >
        <ConfirmDialog
          isOpen={false}
          title=""
          confirmLabel="Confirm"
          onConfirm={() => {}}
          variant="default"
        />
      </ErrorBoundary>
    );
  }

  const options = confirm.options;
  const variant = options.destructive ? "destructive" : "default";

  return (
    <ErrorBoundary
      variant="component"
      componentName="PluginConfirmPromptDialog"
      resetKeys={[resetKey]}
    >
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveOnce(confirm.promptId, false)}
        title={options.title}
        description={options.message}
        confirmLabel={options.confirmLabel || "Confirm"}
        cancelLabel={options.cancelLabel || "Cancel"}
        onConfirm={() => resolveOnce(confirm.promptId, true)}
        variant={variant}
      >
        <p className="text-xs text-daintree-text/40">
          Requested by the '{confirm.pluginId}' plugin
        </p>
      </ConfirmDialog>
    </ErrorBoundary>
  );
}
