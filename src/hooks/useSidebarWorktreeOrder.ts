import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { WorktreeState } from "@/types";
import { orderWorktreesLikeSidebar, type SidebarOrderPrefs } from "@/lib/worktreeFilters";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useWorktrees } from "./useWorktrees";

// Stable sentinel for the disabled path, mirroring `useWorktrees`: the consumer
// this exists for is a picker that stays mounted while closed, so a fresh array
// every render would defeat the gate it asked for.
const EMPTY_WORKTREE_ORDER: WorktreeState[] = [];

/**
 * Every worktree in the sidebar's order, for surfaces that need to list them
 * the way the user already reads them. Reads the four ordering preferences out
 * of `worktreeFilterStore` so consumers do not have to know which fields
 * matter.
 *
 * `enabled: false` short-circuits to a stable empty array and stops selecting
 * the preferences at all, so a closed picker re-renders for neither.
 */
export function useSidebarWorktreeOrder(options?: { enabled?: boolean }): WorktreeState[] {
  const enabled = options?.enabled ?? true;
  const { worktrees } = useWorktrees({ enabled });

  const prefs = useWorktreeFilterStore(
    useShallow((state): SidebarOrderPrefs | null =>
      enabled
        ? {
            orderBy: state.orderBy,
            groupByType: state.groupByType,
            pinnedWorktrees: state.pinnedWorktrees,
            manualOrder: state.manualOrder,
          }
        : null
    )
  );

  return useMemo(
    () => (prefs === null ? EMPTY_WORKTREE_ORDER : orderWorktreesLikeSidebar(worktrees, prefs)),
    [worktrees, prefs]
  );
}
