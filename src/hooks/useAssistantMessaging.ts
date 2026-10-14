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

interface LaneReader {
  laneKey: string | null;
  revision: number;
  attempts: number;
  accept: (next: AssistantMessagingState) => boolean;
  read: () => void;
}

function idleReader(laneKey: string | null): LaneReader {
  return { laneKey, revision: -1, attempts: 0, accept: () => false, read: () => {} };
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
  // One per effect run, so a reply from an earlier visit to the same lane, or
  // an earlier session on it, is told apart from this one's by identity.
  const current = useRef<LaneReader>(idleReader(null));

  useEffect(() => {
    const lane = idleReader(laneKey);
    current.current = lane;
    if (projectId === null || laneKey === null || !assistantMessagingClient.isAvailable()) {
      return undefined;
    }
    lane.accept = (next) => {
      if (current.current !== lane || next.revision < lane.revision) return false;
      lane.revision = next.revision;
      setState({ laneKey, value: next });
      return true;
    };
    lane.read = () => {
      assistantMessagingClient.getState({ projectId, slot }).then(
        (next) => lane.accept(next),
        () => {}
      );
    };
    const offChanged = assistantMessagingClient.onChanged(lane.read);
    // A host that restarted counts its revisions from zero again.
    const offResync = onHostResync(() => {
      lane.revision = -1;
      lane.read();
    });
    lane.read();
    return () => {
      lane.accept = () => false;
      offChanged();
      offResync();
    };
  }, [projectId, slot, laneKey, sessionId]);

  const setLaneEnrolled = useCallback(
    (enrolled: boolean) => {
      const lane = current.current;
      if (projectId === null || laneKey === null || !assistantMessagingClient.isAvailable()) {
        return;
      }
      // Only the latest attempt on this lane speaks: an earlier one's reply,
      // refusal or failure is stale by the time a newer one is in flight.
      const attempt = ++lane.attempts;
      const latest = () => current.current === lane && lane.attempts === attempt;
      setRefusal(null);
      assistantMessagingClient.setLaneEnrolled({ projectId, slot, enrolled }).then(
        (result) => {
          if (!latest()) return;
          lane.accept(result.state);
          setRefusal(result.refusal ? { laneKey, value: result.refusal } : null);
        },
        () => {
          if (latest()) setRefusal({ laneKey, value: "unavailable" });
        }
      );
    },
    [projectId, slot, laneKey]
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
