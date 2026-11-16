import { usePanelStore } from "@/store";
import type { PanelInstance } from "@shared/types/panel";
import type { TrashedTerminal } from "@/store/slices";
import { useStabilizer } from "@/hooks/useStabilizedSelector";
import { parkedPanelsEquivalent } from "./dockPanelParkedSnapshot";
import { TrashContainer } from "./TrashContainer";

function trashedPanelsEquivalent(
  a: Record<string, PanelInstance>,
  b: Record<string, PanelInstance>
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((id) => b[id] !== undefined && parkedPanelsEquivalent(a[id]!, b[id]));
}

/**
 * The trash tray with its panels resolved from the store here rather than in
 * `ContentDock`: a trashed agent still streams, and its record changing must
 * repaint the tray, not the whole rail (#17053).
 */
export function ConnectedTrashContainer({ compact }: { compact?: boolean }) {
  const trashedTerminals = usePanelStore((state) => state.trashedTerminals);
  // A trashed agent still streams, and every flush replaces its record. The
  // tray reads titles, kind and worktree — none of which the status buffer
  // writes — so a record that differs only by those writes is the same row.
  const stabilize = useStabilizer<Record<string, PanelInstance>>();
  const trashedPanelsById = usePanelStore((state) => {
    const result: Record<string, PanelInstance> = {};
    for (const trashed of state.trashedTerminals.values()) {
      const panel = state.panelsById[trashed.id];
      if (panel) result[trashed.id] = panel;
    }
    return stabilize(result, trashedPanelsEquivalent);
  });

  const trashedItems = Array.from(trashedTerminals.values())
    .map((trashed) => ({
      terminal: trashedPanelsById[trashed.id] as PanelInstance | undefined,
      trashedInfo: trashed,
    }))
    .filter(
      (item): item is { terminal: PanelInstance; trashedInfo: TrashedTerminal } =>
        item.terminal !== undefined
    );

  return <TrashContainer trashedTerminals={trashedItems} compact={compact} />;
}
