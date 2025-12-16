import { useSyncExternalStore, useCallback } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import type { UnseenOutputSnapshot } from "@/services/terminal/TerminalUnseenOutputTracker";

const SERVER_SNAPSHOT: UnseenOutputSnapshot = { isUserScrolledBack: false, unseen: 0 };

export function useTerminalUnseenOutput(terminalId: string): UnseenOutputSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      terminalInstanceService.subscribeUnseenOutput(terminalId, onStoreChange),
    [terminalId]
  );

  const getSnapshot = useCallback(
    () => terminalInstanceService.getUnseenOutputSnapshot(terminalId),
    [terminalId]
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
}
