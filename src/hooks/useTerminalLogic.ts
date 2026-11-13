import { useState, useCallback } from "react";
import type { RetryAction } from "@/store/errorStore";
import { useErrorStore } from "@/store/errorStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { logError } from "@/utils/logger";
import { errorsClient } from "@/clients";

interface UseTerminalLogicOptions {
  id: string;
  removeError: (errorId: string) => void;
  restartKey?: number;
}

export interface UseTerminalLogicReturn {
  // Error handling
  handleErrorRetry: (
    errorId: string,
    action: RetryAction,
    args?: Record<string, unknown>
  ) => Promise<void>;

  // Exit handling
  isExited: boolean;
  exitCode: number | null;
  /** Null when the terminal is known to be gone but no exit code was seen. */
  handleExit: (code: number | null) => void;
}

export function useTerminalLogic({
  id,
  removeError,
  restartKey,
}: UseTerminalLogicOptions): UseTerminalLogicReturn {
  // Tagged with the terminal and run it was heard on rather than reset when
  // they change: a tab group reuses the pane for its next tab, and a reset
  // would still let that tab commit once with the last one's exit, or a late
  // exit from the last tab land on it (#16878).
  const [heardExit, setHeardExit] = useState<{
    id: string;
    restartKey: number | undefined;
    code: number | null;
  } | null>(null);
  const clearRetryProgress = useErrorStore((state) => state.clearRetryProgress);
  // The exit stream is one-shot: a pane that mounts after it fired, or an exit
  // only the store heard of (a host that restarted without the terminal), is
  // read from the store instead. Undefined while the terminal is live.
  const storeExitCode = usePanelStore((state) => {
    const panel = state.panelsById[id];
    if (!panel || !isPtyPanel(panel) || panel.runtimeStatus !== "exited") return undefined;
    return panel.exitCode ?? null;
  });

  const handleExit = useCallback(
    (code: number | null) => {
      const safeCode = code === null ? null : Number.isFinite(code) ? code : 0;
      setHeardExit({ id, restartKey, code: safeCode });
    },
    [id, restartKey]
  );
  const isExited = heardExit !== null && heardExit.id === id && heardExit.restartKey === restartKey;

  // Promise-method cleanup instead of try/finally: a statement-level finally
  // clause bails React Compiler memoization for the whole per-terminal hook.
  const handleErrorRetry = useCallback(
    (errorId: string, action: RetryAction, args?: Record<string, unknown>) =>
      errorsClient
        .retry(errorId, action, args)
        .then(() => {
          removeError(errorId);
        })
        .catch((error) => {
          logError("Error retry failed", error);
        })
        .finally(() => {
          clearRetryProgress(errorId);
        }),
    [removeError, clearRetryProgress]
  );

  return {
    // Error handling
    handleErrorRetry,

    // Exit handling
    isExited: isExited || storeExitCode !== undefined,
    exitCode: isExited ? heardExit.code : (storeExitCode ?? null),
    handleExit,
  };
}
