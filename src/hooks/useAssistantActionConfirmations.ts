import { useEffect, useState, useCallback, useRef } from "react";

export interface ConfirmationRequest {
  requestId: string;
  actionId: string;
  actionName?: string;
  args?: Record<string, unknown>;
  danger: "safe" | "confirm" | "restricted";
}

export function useAssistantActionConfirmations(): {
  pendingConfirmation: ConfirmationRequest | null;
  approve: () => void;
  deny: () => void;
} {
  const [queue, setQueue] = useState<ConfirmationRequest[]>([]);
  const respondingRef = useRef<string | null>(null);

  const pendingConfirmation = queue[0] ?? null;

  useEffect(() => {
    if (!window.electron?.appAgent?.onConfirmationRequest) {
      return;
    }

    const cleanup = window.electron.appAgent.onConfirmationRequest((payload) => {
      setQueue((prev) => [...prev, payload]);
    });

    return cleanup;
  }, []);

  const approve = useCallback(() => {
    if (!pendingConfirmation || respondingRef.current === pendingConfirmation.requestId) {
      return;
    }

    respondingRef.current = pendingConfirmation.requestId;

    if (window.electron?.appAgent?.sendConfirmationResponse) {
      window.electron.appAgent.sendConfirmationResponse({
        requestId: pendingConfirmation.requestId,
        approved: true,
      });
      setQueue((prev) => prev.slice(1));
      respondingRef.current = null;
    }
  }, [pendingConfirmation]);

  const deny = useCallback(() => {
    if (!pendingConfirmation || respondingRef.current === pendingConfirmation.requestId) {
      return;
    }

    respondingRef.current = pendingConfirmation.requestId;

    if (window.electron?.appAgent?.sendConfirmationResponse) {
      window.electron.appAgent.sendConfirmationResponse({
        requestId: pendingConfirmation.requestId,
        approved: false,
      });
      setQueue((prev) => prev.slice(1));
      respondingRef.current = null;
    }
  }, [pendingConfirmation]);

  return { pendingConfirmation, approve, deny };
}
