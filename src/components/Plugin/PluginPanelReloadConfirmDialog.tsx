import { type ReactElement, useCallback } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionService } from "@/services/ActionService";
import { usePluginPanelReloadConfirmStore } from "@/store/pluginPanelReloadConfirmStore";

/**
 * App-level host for the confirmation `plugin.reloadPanel` stages when the
 * view reports unsaved work (#12611). One dialog for every path, the menus and
 * an agent's tool call alike, because the action stages it rather than any
 * one surface. Mounted in `AppLayout` because the panel may sit in the dock or
 * a dialog when the reload is asked for.
 */
export function PluginPanelReloadConfirmDialog(): ReactElement | null {
  const pending = usePluginPanelReloadConfirmStore((s) => s.pending);
  const clear = usePluginPanelReloadConfirmStore((s) => s.clear);
  const approve = usePluginPanelReloadConfirmStore((s) => s.approve);

  const handleConfirm = useCallback(() => {
    if (pending === null) return;
    approve(pending.panelId);
    void actionService.dispatch(
      "plugin.reloadPanel",
      { panelId: pending.panelId },
      { source: "user" }
    );
  }, [pending, approve]);

  if (pending === null) return null;

  return (
    <ConfirmDialog
      isOpen
      onClose={clear}
      title="Reload panel with unsaved changes?"
      description={`${pending.panelTitle} has changes it hasn't saved. Reloading the panel discards them.`}
      confirmLabel="Reload panel"
      variant="destructive"
      onConfirm={handleConfirm}
    />
  );
}
