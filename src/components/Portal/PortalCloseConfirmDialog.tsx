import { type ReactElement, useCallback } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionService } from "@/services/ActionService";
import {
  usePortalPendingCloseStore,
  type PortalPendingCloseSnapshot,
} from "@/store/portalPendingCloseStore";

interface DialogCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

export function buildCopy(pending: PortalPendingCloseSnapshot): DialogCopy {
  const count = pending.tabsToClose.length;
  const noun = count === 1 ? "tab" : "tabs";
  switch (pending.kind) {
    case "closeAll":
      return {
        title: "Close all portal tabs?",
        description: `Every portal tab closes and its navigation history is discarded. ${count} ${noun} will close.`,
        confirmLabel: `Close ${count} portal ${noun}`,
      };
    case "closeOthers":
      return {
        title: "Close other portal tabs?",
        // The kept tab is the one the user invoked from (right-clicked tab
        // or active tab) — not necessarily the active one — so name neither;
        // the list below shows exactly which tabs close.
        description: `All other portal tabs close and their navigation history is discarded. ${count} ${noun} will close.`,
        confirmLabel: `Close ${count} portal ${noun}`,
      };
  }
}

/**
 * App-level confirm-dialog host for bulk portal-tab closes dispatched at the
 * 3+-tab escalation threshold (from a keybinding, the action palette, or the
 * portal toolbar). Subscribes to `portalPendingCloseStore` and re-dispatches
 * the matching action with `{ confirmed: true }` on confirm. Mounted in
 * `AppLayout` rather than `PortalDock` because the portal panel can be hidden
 * when the action fires.
 */
export function PortalCloseConfirmDialog(): ReactElement | null {
  const pending = usePortalPendingCloseStore((s) => s.pending);
  const clear = usePortalPendingCloseStore((s) => s.clear);

  const handleConfirm = useCallback(() => {
    if (pending === null) return;
    switch (pending.kind) {
      case "closeAll":
        void actionService.dispatch("portal.closeAllTabs", { confirmed: true }, { source: "user" });
        break;
      case "closeOthers":
        // Defensive: without the kept tab the action would fall back to the
        // active tab, which may have changed since the dialog opened.
        if (!pending.keepTabId) break;
        void actionService.dispatch(
          "portal.closeOthers",
          { tabId: pending.keepTabId, confirmed: true },
          { source: "user" }
        );
        break;
    }
    clear();
  }, [pending, clear]);

  if (pending === null) return null;

  const copy = buildCopy(pending);

  return (
    <ConfirmDialog
      isOpen
      onClose={clear}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      variant="destructive"
      onConfirm={handleConfirm}
    >
      <ul className="max-h-48 space-y-1 overflow-y-auto rounded border border-daintree-border bg-daintree-bg/50 p-2">
        {pending.tabsToClose.map((tab) => (
          <li key={tab.id} className="truncate text-xs">
            <span className="text-daintree-text">{tab.title || "Untitled"}</span>
            {tab.url ? <span className="text-daintree-text/40"> — {tab.url}</span> : null}
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
