import { useCallback, useSyncExternalStore } from "react";
import {
  peek as peekTerminalService,
  subscribeWhenReady,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import type { ScrollbackRestoreAggregate } from "@/services/terminal/scrollbackRestoreAggregate";

/**
 * Reactively read the batch scrollback-restore aggregate from
 * `TerminalInstanceService`. Three separate `useSyncExternalStore` calls, each
 * returning a primitive `number`, keep snapshots referentially stable — a
 * single object snapshot would allocate a new reference every render and loop
 * indefinitely. Mounted on the empty project view, so every count reads 0
 * until the service loads.
 */
export function useScrollbackRestoreAggregate(): ScrollbackRestoreAggregate {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeWhenReady(
        (service) => service.subscribeScrollbackRestoreState(onStoreChange),
        onStoreChange
      ),
    []
  );

  const pendingCount = useSyncExternalStore(
    subscribe,
    useCallback(() => peekTerminalService()?.getScrollbackRestorePendingCount() ?? 0, [])
  );
  const inProgressCount = useSyncExternalStore(
    subscribe,
    useCallback(() => peekTerminalService()?.getScrollbackRestoreInProgressCount() ?? 0, [])
  );
  const totalCount = useSyncExternalStore(
    subscribe,
    useCallback(() => peekTerminalService()?.getScrollbackRestoreTotalCount() ?? 0, [])
  );

  return { pendingCount, inProgressCount, totalCount };
}
