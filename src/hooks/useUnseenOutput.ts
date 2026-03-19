import { useCallback, useSyncExternalStore } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

export function useUnseenOutput(id: string) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => terminalInstanceService.subscribeUnseenOutput(id, onStoreChange),
    [id]
  );
  const getSnapshot = useCallback(() => terminalInstanceService.getUnseenOutputSnapshot(id), [id]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  return {
    isUserScrolledBack: snapshot.isUserScrolledBack,
    hasUnseenOutput: snapshot.isUserScrolledBack && snapshot.unseen > 0,
  };
}
