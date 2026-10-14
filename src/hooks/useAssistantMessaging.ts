import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssistantMessagingEnrollDenial,
  AssistantMessagingState,
} from "@shared/types/ipc/assistantMessaging";
import { assistantMessagingClient } from "@/clients/assistantMessagingClient";

export interface AssistantMessagingControls {
  state: AssistantMessagingState | null;
  /** Why the last attempt to turn the lane on was refused, until the next attempt. */
  refusal: AssistantMessagingEnrollDenial | null;
  setLaneEnrolled: (enrolled: boolean) => void;
  setPaused: (paused: boolean) => void;
  dismissRefusal: () => void;
}

/**
 * The messaging controls for one assistant lane of this view's project. The
 * policy lives in main (the host's, for a remote window), so this reads it on
 * mount and again on every change main pushes, dropping a read a newer one
 * overtook.
 */
export function useAssistantMessaging(
  projectId: string | null,
  slot: number,
  /** The lane's running session, so a launch or relaunch is read without waiting on a push. */
  sessionId: string | null
): AssistantMessagingControls {
  const [state, setState] = useState<AssistantMessagingState | null>(null);
  const [refusal, setRefusal] = useState<AssistantMessagingEnrollDenial | null>(null);
  const latest = useRef(-1);

  const accept = useCallback((next: AssistantMessagingState) => {
    if (next.revision < latest.current) return;
    latest.current = next.revision;
    setState(next);
  }, []);

  useEffect(() => {
    latest.current = -1;
    setRefusal(null);
    if (projectId === null || !assistantMessagingClient.isAvailable()) {
      setState(null);
      return undefined;
    }
    let disposed = false;
    const read = () => {
      assistantMessagingClient.getState({ projectId, slot }).then(
        (next) => {
          if (!disposed) accept(next);
        },
        () => {}
      );
    };
    const off = assistantMessagingClient.onChanged(read);
    read();
    return () => {
      disposed = true;
      off();
    };
  }, [projectId, slot, sessionId, accept]);

  const setLaneEnrolled = useCallback(
    (enrolled: boolean) => {
      if (projectId === null || !assistantMessagingClient.isAvailable()) return;
      setRefusal(null);
      assistantMessagingClient.setLaneEnrolled({ projectId, slot, enrolled }).then(
        (result) => {
          accept(result.state);
          setRefusal(result.refusal);
        },
        () => setRefusal("unavailable")
      );
    },
    [projectId, slot, accept]
  );

  const setPaused = useCallback((paused: boolean) => {
    if (!assistantMessagingClient.isAvailable()) return;
    assistantMessagingClient.setPaused(paused).then(
      (now) => setState((current) => (current ? { ...current, paused: now } : current)),
      () => {}
    );
  }, []);

  const dismissRefusal = useCallback(() => setRefusal(null), []);

  return { state, refusal, setLaneEnrolled, setPaused, dismissRefusal };
}
