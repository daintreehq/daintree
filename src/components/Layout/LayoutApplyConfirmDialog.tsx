import { useCallback, useRef } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useLayoutApplyConfirmStore } from "@/store/layoutApplyConfirmStore";

/** Read-time gate after each dialog is promoted, as the plugin confirmations use. */
const CONFIRM_COOLDOWN_MS = 1_200;

/**
 * Singleton dialog for a layout that starts terminals (#13780). Lists every
 * terminal the layout's recipes start, the way the recipe confirmation does,
 * and nothing in the layout opens or moves until the user approves.
 */
export function LayoutApplyConfirmDialog() {
  const current = useLayoutApplyConfirmStore((state) => state.current);
  const resolveCurrent = useLayoutApplyConfirmStore((state) => state.resolveCurrent);

  // `resolveCurrent` promotes the next request synchronously, so a double
  // click would otherwise approve a layout the user hasn't read yet.
  const handledRequestIdRef = useRef<string | null>(null);
  const resolveOnce = useCallback(
    (requestId: string, approved: boolean) => {
      if (handledRequestIdRef.current === requestId) return;
      handledRequestIdRef.current = requestId;
      resolveCurrent(approved);
    },
    [resolveCurrent]
  );

  if (current === null) {
    return (
      <ConfirmDialog
        isOpen={false}
        title=""
        confirmLabel="Apply layout"
        onConfirm={() => {}}
        variant="default"
      />
    );
  }

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveOnce(current.requestId, false)}
      title={`Apply '${current.layoutName}'?`}
      description={`This layout from ${current.pluginName} starts the terminals below, then arranges its panels. Panels it doesn't list stay where they are.`}
      confirmLabel="Apply layout"
      cancelLabel="Cancel"
      onConfirm={() => resolveOnce(current.requestId, true)}
      variant="default"
      hasPreview
      bodyResetKey={current.requestId}
      confirmCooldownMs={CONFIRM_COOLDOWN_MS}
      cooldownKey={current.requestId}
    >
      <div className="max-h-60 space-y-1 overflow-y-auto">
        {current.previewLines.map((line, index) => (
          <div
            key={index}
            className="min-h-3 pl-4 -indent-4 font-mono text-xs break-words whitespace-pre-wrap text-text-primary"
          >
            {line}
          </div>
        ))}
      </div>
    </ConfirmDialog>
  );
}
