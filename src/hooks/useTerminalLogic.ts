import { useState, useCallback, useEffect } from "react";
import type { RetryAction } from "@/store";
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
  handleExit: (code: number) => void;
}

export function useTerminalLogic({
  id,
  removeError,
  restartKey,
}: UseTerminalLogicOptions): UseTerminalLogicReturn {
  const [isExited, setIsExited] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);

  // Reset exit state when terminal ID or restartKey changes
  useEffect(() => {
    setIsExited(false);
    setExitCode(null);
  }, [id, restartKey]);

  const handleExit = useCallback((code: number) => {
    setIsExited(true);
    setExitCode(code);
  }, []);

  const handleErrorRetry = useCallback(
    async (errorId: string, action: RetryAction, args?: Record<string, unknown>) => {
      try {
        await errorsClient.retry(errorId, action, args);
        removeError(errorId);
      } catch (error) {
        console.error("Error retry failed:", error);
      }
    },
    [removeError]
  );

  return {
    // Error handling
    handleErrorRetry,

    // Exit handling
    isExited,
    exitCode,
    handleExit,
  };
}
