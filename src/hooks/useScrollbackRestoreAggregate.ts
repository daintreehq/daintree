import { useCallback, useSyncExternalStore } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import type { ScrollbackRestoreAggregate } from "@/services/terminal/scrollbackRestoreAggregate";

/**
 * Reactively read the batch scrollback-restore aggregate from
 * `TerminalInstanceService`. Three separate `useSyncExternalStore` calls, each
 * returning a primitive `number`, keep snapshots referentially stable — a
 * single object snapshot would allocate a new reference every render and loop
 * indefinitely.
 */
export function useScrollbackRestoreAggregate(): ScrollbackRestoreAggregate {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      terminalInstanceService.subscribeScrollbackRestoreState(onStoreChange),
    []
  );

  const pendingCount = useSyncExternalStore(
    subscribe,
    useCallback(() => terminalInstanceService.getScrollbackRestorePendingCount(), [])
  );
  const inProgressCount = useSyncExternalStore(
    subscribe,
    useCallback(() => terminalInstanceService.getScrollbackRestoreInProgressCount(), [])
  );
  const totalCount = useSyncExternalStore(
    subscribe,
    useCallback(() => terminalInstanceService.getScrollbackRestoreTotalCount(), [])
  );

  return { pendingCount, inProgressCount, totalCount };
}
