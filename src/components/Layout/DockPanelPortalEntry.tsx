import { memo } from "react";
import { createPortal } from "react-dom";
import { usePanelStore } from "@/store";
import { isDockPanel, isPtyPanel, type DockPanelData } from "@shared/types/panel";
import { canDuplicatePanelKind } from "@/services/terminal/panelDuplicationService";
import { DockedPanel } from "@/components/Terminal/DockedPanel";
import { DockPopoverChildProvider } from "@/components/ui/DockPopoverChildContext";
import {
  DragHandleProvider,
  type DragHandleContextValue,
} from "@/components/DragDrop/DragHandleContext";
import { useStabilizer } from "@/hooks/useStabilizedSelector";
import { parkedPanelsEquivalent } from "./dockPanelParkedSnapshot";

interface DockPanelPortalEntryProps {
  panelId: string;
  wrapper: HTMLElement;
  isActive: boolean;
  dragHandle: DragHandleContextValue;
  onPopoverClose: (panelId: string) => void;
  onAddTab: (panel: DockPanelData) => void;
}

/**
 * One panel's body, portaled into its stable wrapper. It reads its own record,
 * so the offscreen host holds ids only and a streaming docked agent no longer
 * repaints every parked body (#17053). While parked, the record it renders from
 * ignores the status buffer's per-frame writes; the open panel is always live.
 */
export const DockPanelPortalEntry = memo(function DockPanelPortalEntry({
  panelId,
  wrapper,
  isActive,
  dragHandle,
  onPopoverClose,
  onAddTab,
}: DockPanelPortalEntryProps) {
  const stabilize = useStabilizer<DockPanelData | undefined>();
  const terminal = usePanelStore((state) => {
    const panel = state.panelsById[panelId];
    return stabilize(panel && isDockPanel(panel) ? panel : undefined, (a, b) => {
      if (a === b) return true;
      if (isActive || !a || !b) return false;
      return parkedPanelsEquivalent(a, b);
    });
  });
  // Only single panels (not in an explicit group) get onAddTab; multi-panel
  // groups handle tabs via DockedTabGroup. A selector, so the answer follows
  // the group rather than whatever this entry last rendered with.
  const isSinglePanel = usePanelStore((state) => {
    const group = state.getPanelGroup(panelId);
    return !group || group.panelIds.length <= 1;
  });

  if (!terminal) return null;

  // Wrap the portaled panel body in DockPopoverChildProvider so any Radix
  // overlay opened from inside the docked panel (e.g. TerminalContextMenu via
  // ContentPanel, panel header dropdowns, tooltips on action buttons) inherits
  // the context. Without this, those overlays would not be stamped with
  // data-dock-popover-child and the dock popover would dismiss when the user
  // clicks a menu item — see #8161.
  const content = (
    <DockPopoverChildProvider>
      <DragHandleProvider value={dragHandle}>
        <div
          data-dock-panel-id={terminal.id}
          className="dock-panel-slot"
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <DockedPanel
            terminal={terminal}
            onPopoverClose={() => onPopoverClose(terminal.id)}
            onAddTab={
              // Dock tab groups are PTY-only (ContentDock resolves groups
              // through isPtyPanel), so only PTY panels get the add-tab
              // affordance. A duplicable non-PTY kind like browser would
              // otherwise spawn a dock group the dock can't render as one.
              isSinglePanel && isPtyPanel(terminal) && canDuplicatePanelKind(terminal.kind)
                ? () => onAddTab(terminal)
                : undefined
            }
            showRestoreControl={isSinglePanel}
          />
        </div>
      </DragHandleProvider>
    </DockPopoverChildProvider>
  );

  // Portal into the stable wrapper. Because the wrapper identity never changes,
  // React keeps the same fiber across open/close — the wrapper is simply
  // relocated in the DOM by moveToDestination.
  return createPortal(content, wrapper, `dock-panel-${terminal.id}`);
});
