import { useEffect } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useMoveTerminalsDialogStore } from "@/store/moveTerminalsDialogStore";
import { MoveTerminalsToAccountDialog } from "./AccountSwitchNotice";

export function MoveTerminalsDialogHost() {
  const opening = useMoveTerminalsDialogStore((state) => state.opening);
  const close = useMoveTerminalsDialogStore((state) => state.close);
  // The opening outlives the host in its store; the next workspace starts without one.
  useEffect(() => () => useMoveTerminalsDialogStore.getState().close(), []);
  return (
    <ErrorBoundary
      variant="component"
      componentName="MoveTerminalsToAccountDialog"
      resetKeys={[opening?.id ?? 0]}
    >
      {opening && (
        <MoveTerminalsToAccountDialog
          key={opening.id}
          agentId={opening.agentId}
          account={opening.account}
          onClose={close}
        />
      )}
    </ErrorBoundary>
  );
}
