import { useCallback, useSyncExternalStore } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

export function useIsHibernated(id: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => terminalInstanceService.subscribeHibernation(id, onStoreChange),
    [id]
  );
  const getSnapshot = useCallback(() => terminalInstanceService.isHibernated(id), [id]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
