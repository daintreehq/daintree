import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { selectOpenDockPopoverId } from "./dockPanelVisibility";

/**
 * The id of the dock popover currently on screen, or null.
 *
 * Dialogs read this to pick their z-tier: a dock popover sits at tier 70, above
 * the standard modal tier, so a dialog opened from inside a docked panel paints
 * underneath the panel that spawned it — focus-trapped and invisible (#11505).
 * Tier 75 exists for exactly this ("dialogs triggered from within popovers", the
 * tier table in `index.css`). Callers promote onto it only while a popover is
 * genuinely rendered, so a dialog opened with no dock popover on screen keeps
 * the standard tier and the tooltips and menus it hosts stay above it.
 *
 * Leaf store imports rather than the `@/store` barrel: suites that mock the
 * barrel for an unrelated component would otherwise hand this hook a partial
 * state and break on `panelIds.includes`.
 *
 * The worktree and help stores are subscribed separately instead of being read
 * imperatively inside the panel selector — a change to either must re-run the
 * derivation, and an imperative read inside a `usePanelStore` selector only
 * re-runs when the *panel* store writes.
 */
export function useOpenDockPopoverId(): string | null {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const helpTerminalId = useHelpPanelStore((state) => state.terminalId);
  return usePanelStore((state) =>
    selectOpenDockPopoverId(state, { helpTerminalId, activeWorktreeId })
  );
}
