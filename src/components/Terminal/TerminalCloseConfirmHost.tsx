import { useCallback, useEffect, useState } from "react";
import { usePanelStore } from "@/store/panelStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/**
 * Bridges the keyboard-driven `terminal.close` action to the same close
 * confirmation dialog the per-tab and header X buttons render inline. The
 * action dispatches `daintree:close-confirm` when the target is a "working"
 * agent; this host listens for that event and shows the dialog.
 */
export function TerminalCloseConfirmHost() {
  const [pendingTerminalId, setPendingTerminalId] = useState<string | null>(null);

  useEffect(() => {
    const handleConfirm = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as { terminalId?: unknown } | undefined;
      const id = typeof detail?.terminalId === "string" ? detail.terminalId : null;
      if (!id) return;
      // If a dialog is already open for another terminal, ignore the new
      // event rather than silently swapping target — the user is staring at
      // a dialog naming one terminal and clicking confirm should not close a
      // different one. Rapid Cmd+W or agent-driven dispatches land here.
      setPendingTerminalId((prev) => prev ?? id);
    };

    const controller = new AbortController();
    window.addEventListener("daintree:close-confirm", handleConfirm, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, []);

  const handleClose = useCallback(() => {
    setPendingTerminalId(null);
  }, []);

  const handleConfirm = useCallback(() => {
    const id = pendingTerminalId;
    setPendingTerminalId(null);
    if (id) usePanelStore.getState().trashPanel(id);
  }, [pendingTerminalId]);

  return (
    <ConfirmDialog
      isOpen={pendingTerminalId !== null}
      onClose={handleClose}
      title="Stop this agent?"
      description="The agent is currently working. Closing this tab will stop it."
      confirmLabel="Stop and close"
      onConfirm={handleConfirm}
      variant="destructive"
    />
  );
}
