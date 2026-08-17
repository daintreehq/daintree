import { use, useCallback, useSyncExternalStore } from "react";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";

const NO_WORKTREES: ReadonlyMap<string, WorktreeSnapshot> = new Map();

/**
 * The view's worktrees, or an empty map when no view store is in scope.
 *
 * For consumers that merely decorate — a header pill, an ambient marker — where
 * a missing provider should mean "nothing to show" rather than a thrown render.
 * `useWorktreeStore` stays the right call for anything that genuinely cannot
 * work without the store.
 *
 * Deliberately its own module rather than a second export of
 * `useWorktreeStore`: ~30 suites already `vi.mock` that module with only the one
 * export, and a partial mock throws on the missing name the moment anything
 * touches it. Living here, those mocks are untouched and get the real,
 * provider-tolerant implementation.
 *
 * Subscribes directly instead of via `useStore` because the hook must be
 * unconditional while the store may be absent. The state's `worktrees` map keeps
 * a stable identity across polls that change nothing, so this doesn't spin.
 */
export function useWorktreesOptional(): ReadonlyMap<string, WorktreeSnapshot> {
  const store = use(WorktreeStoreContext);
  const subscribe = useCallback(
    (onStoreChange: () => void) => (store ? store.subscribe(onStoreChange) : () => {}),
    [store]
  );
  const getSnapshot = useCallback(
    () => (store ? store.getState().worktrees : NO_WORKTREES),
    [store]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
