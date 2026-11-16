import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { SortableDockItem } from "@/components/DragDrop";
import { dockChipTitle } from "./dockChipTitle";
import { DockedTerminalItem } from "./DockedTerminalItem";
import { DockedNonPtyPanelItem } from "./DockedNonPtyPanelItem";
import { DockedTabGroup } from "./DockedTabGroup";
import type { DockRenderDescriptor } from "./dockRenderItems";

interface ConnectedDockItemProps {
  descriptor: DockRenderDescriptor;
  sourceIndex: number;
  sessionTag: string | undefined;
}

/**
 * One rail chip, reading its own panels from the store. The rail holds only
 * ids, so a streaming docked agent repaints its own chip and nothing around it
 * (#17053).
 */
export const ConnectedDockItem = memo(function ConnectedDockItem({
  descriptor,
  sourceIndex,
  sessionTag,
}: ConnectedDockItemProps) {
  const { group, panelIds } = descriptor;
  const panels = usePanelStore(
    useShallow((state) => {
      const result: PanelInstance[] = [];
      for (const id of panelIds) {
        const panel = state.panelsById[id];
        if (panel) result.push(panel);
      }
      return result;
    })
  );

  if (panels.length === 0) return null;

  // Single-panel group: render the kind's chip directly
  if (panelIds.length === 1) {
    const terminal = panels[0]!;
    return (
      <SortableDockItem terminal={terminal} sourceIndex={sourceIndex}>
        {isPtyPanel(terminal) ? (
          <DockedTerminalItem terminal={terminal} sessionTag={sessionTag} />
        ) : (
          <DockedNonPtyPanelItem panel={terminal} displayTitle={dockChipTitle(terminal)} />
        )}
      </SortableDockItem>
    );
  }

  // Multi-panel group: pass group context for group-aware DnD. Group members
  // resolve PTY-only (`buildDockRenderItems`), so the narrow never drops one.
  return (
    <SortableDockItem
      terminal={panels[0]!}
      sourceIndex={sourceIndex}
      groupId={group.id}
      groupPanelIds={group.panelIds}
    >
      <DockedTabGroup group={group} panels={panels.filter(isPtyPanel)} />
    </SortableDockItem>
  );
});
