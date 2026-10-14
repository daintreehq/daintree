import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssistantMessagingEnrollDenial,
  AssistantMessagingState,
} from "@shared/types/ipc/assistantMessaging";
import { assistantMessagingClient } from "@/clients/assistantMessagingClient";
import { onHostResync } from "@/store/hostResyncSignal";

export interface AssistantMessagingControls {
  state: AssistantMessagingState | null;
  /** Why the last attempt to turn the lane on was refused, until the next attempt. */
  refusal: AssistantMessagingEnrollDenial | null;
  /** Identifies the lane `state` belongs to, so a notice dismissed on one lane stays put on another. */
  laneKey: string | null;
  setLaneEnrolled: (enrolled: boolean) => void;
  setPaused: (paused: boolean) => void;
  dismissRefusal: () => void;
}

interface Tagged<T> {
  laneKey: string;
  value: T;
}

/**
 * The messaging controls for one assistant lane of this view's project. The
 * policy lives in main (the host's, for a remote window), so this reads it on
 * mount, on every change main pushes and whenever a remote link resyncs,
 * dropping a read a newer one overtook. Everything it holds is tagged with the
 * lane it was read for, so a reply that lands after a lane switch is ignored
 * and the new lane never shows the old one's state while it loads.
 */
export function useAssistantMessaging(
  projectId: string | null,
  slot: number,
  /** The lane's running session, so a launch or relaunch is read without waiting on a push. */
  sessionId: string | null
): AssistantMessagingControls {
  const laneKey = projectId === null ? null : `${projectId}\u0000${slot}`;
  const [state, setState] = useState<Tagged<AssistantMessagingState> | null>(null);
  const [refusal, setRefusal] = useState<Tagged<AssistantMessagingEnrollDenial> | null>(null);
  const current = useRef<{ laneKey: string | null; revision: number; read: () => void }>({
    laneKey: null,
    revision: -1,
    read: () => {},
  });

  const accept = useCallback((key: string, next: AssistantMessagingState): void => {
    const lane = current.current;
    if (lane.laneKey !== key || next.revision < lane.revision) return;
    lane.revision = next.revision;
    setState({ laneKey: key, value: next });
  }, []);

  useEffect(() => {
    const lane = { laneKey, revision: -1, read: () => {} };
    current.current = lane;
    if (projectId === null || laneKey === null || !assistantMessagingClient.isAvailable()) {
      return undefined;
    }
    lane.read = () => {
      assistantMessagingClient.getState({ projectId, slot }).then(
        (next) => accept(laneKey, next),
        () => {}
      );
    };
    const offChanged = assistantMessagingClient.onChanged(lane.read);
    const offResync = onHostResync(lane.read);
    lane.read();
    return () => {
      lane.laneKey = null;
      offChanged();
      offResync();
    };
  }, [projectId, slot, laneKey, sessionId, accept]);

  const setLaneEnrolled = useCallback(
    (enrolled: boolean) => {
      if (projectId === null || laneKey === null || !assistantMessagingClient.isAvailable()) {
        return;
      }
      setRefusal(null);
      assistantMessagingClient.setLaneEnrolled({ projectId, slot, enrolled }).then(
        (result) => {
          if (current.current.laneKey !== laneKey) return;
          accept(laneKey, result.state);
          setRefusal(result.refusal ? { laneKey, value: result.refusal } : null);
        },
        () => {
          if (current.current.laneKey === laneKey) {
            setRefusal({ laneKey, value: "unavailable" });
          }
        }
      );
    },
    [projectId, slot, laneKey, accept]
  );

  // The reply is a bare flag with no revision, so read the versioned state
  // instead of merging it over a newer push.
  const setPaused = useCallback((paused: boolean) => {
    if (!assistantMessagingClient.isAvailable()) return;
    const lane = current.current;
    assistantMessagingClient.setPaused(paused).then(
      () => lane.read(),
      () => lane.read()
    );
  }, []);

  const dismissRefusal = useCallback(() => setRefusal(null), []);

  return {
    state: state && state.laneKey === laneKey ? state.value : null,
    refusal: refusal && refusal.laneKey === laneKey ? refusal.value : null,
    laneKey,
    setLaneEnrolled,
    setPaused,
    dismissRefusal,
  };
}
