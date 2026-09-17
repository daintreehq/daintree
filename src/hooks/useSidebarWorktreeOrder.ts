import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { WorktreeState } from "@/types";
import { orderWorktreesLikeSidebar, type SidebarOrderPrefs } from "@/lib/worktreeFilters";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useWorktrees } from "./useWorktrees";

// Stable sentinel for the disabled path, mirroring `useWorktrees`: the consumer
// this exists for is a picker that stays mounted while closed, so a fresh array
// every render would defeat the gate it asked for. Frozen because every
// disabled caller shares this one array — an in-place push would otherwise leak
// into every other picker for the lifetime of the module.
const EMPTY_WORKTREE_ORDER: readonly WorktreeState[] = Object.freeze([]);

/**
 * Every worktree in the sidebar's order, for surfaces that need to list them
 * the way the user already reads them. Reads the four ordering preferences out
 * of `worktreeFilterStore` so consumers do not have to know which fields
 * matter.
 *
 * `enabled: false` short-circuits to a stable empty array and stops selecting
 * the preferences at all, so a closed picker re-renders for neither.
 *
 * The result is memoised and shared, so it is `readonly`: sort or filter a copy.
 */
export function useSidebarWorktreeOrder(options?: { enabled?: boolean }): readonly WorktreeState[] {
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
