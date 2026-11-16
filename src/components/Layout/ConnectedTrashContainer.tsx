import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store";
import type { PanelInstance } from "@shared/types/panel";
import type { TrashedTerminal } from "@/store/slices";
import { TrashContainer } from "./TrashContainer";

/**
 * The trash tray with its panels resolved from the store here rather than in
 * `ContentDock`: a trashed agent still streams, and its record changing must
 * repaint the tray, not the whole rail (#17053).
 */
export function ConnectedTrashContainer({ compact }: { compact?: boolean }) {
  const trashedTerminals = usePanelStore((state) => state.trashedTerminals);
  // Values are the actual store panel references (not freshly constructed), so
  // `useShallow` bails unless the trashed set — or a trashed panel's reference —
  // actually changes, rather than on every unrelated status-buffer flush (#10908).
  const trashedPanelsById = usePanelStore(
    useShallow((state) => {
      const result: Record<string, PanelInstance> = {};
      for (const trashed of state.trashedTerminals.values()) {
        const panel = state.panelsById[trashed.id];
        if (panel) result[trashed.id] = panel;
      }
      return result;
    })
  );

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
