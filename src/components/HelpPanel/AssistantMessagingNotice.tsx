import { useState } from "react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import type {
  AssistantMessagingEndReason,
  AssistantMessagingEnrollDenial,
  AssistantMessagingState,
} from "@shared/types/ipc/assistantMessaging";

const ENDED_DESCRIPTION: Record<AssistantMessagingEndReason, string> = {
  revoked: "Its session was revoked.",
  displaced: "Another window took over this assistant.",
  relaunched: "It was relaunched, and consent doesn't carry over to a new run.",
  stopped: "Its session ended.",
  "shell-gone": "The machine that turned it on disconnected.",
};

const REFUSAL_TITLE: Record<AssistantMessagingEnrollDenial, string> = {
  "not-running": "Start this assistant before it can accept messages",
  "wrong-shell": "Another machine turned messages on for this assistant",
  "hub-taken": "Another assistant on this machine already accepts messages",
  unsupported: "Messages between machines aren't available here",
  unavailable: "Couldn't change whether this assistant accepts messages",
};

interface AssistantMessagingNoticeProps {
  state: AssistantMessagingState | null;
  refusal: AssistantMessagingEnrollDenial | null;
  onDismissRefusal: () => void;
}

/**
 * Says when a lane stopped accepting messages from other machines without the
 * person turning it off, so nobody is left thinking it's still reachable. The
 * live region is mounted from the start, so the notice is announced when it
 * appears rather than only when something inside it takes focus.
 */
export function AssistantMessagingNotice({
  state,
  refusal,
  onDismissRefusal,
}: AssistantMessagingNoticeProps) {
  const [dismissedEndedAt, setDismissedEndedAt] = useState<number | null>(null);
  const ended = state?.available ? state.lane.ended : null;
  const showEnded = ended !== null && ended.at !== dismissedEndedAt;
  const showRefusal = refusal !== null && !showEnded;

  return (
    <div role="status" aria-live="polite" data-testid="assistant-messaging-notice">
      {showEnded && (
        <InlineStatusBanner
          severity="warning"
          layout="inline"
          animated={false}
          ariaLive="off"
          title="Stopped accepting messages from other machines"
          description={ENDED_DESCRIPTION[ended.reason]}
          onClose={() => setDismissedEndedAt(ended.at)}
          closeAriaLabel="Dismiss messaging notice"
        />
      )}
      {showRefusal && (
        <InlineStatusBanner
          severity="neutral"
          layout="inline"
          animated={false}
          ariaLive="off"
          title={REFUSAL_TITLE[refusal]}
          onClose={onDismissRefusal}
          closeAriaLabel="Dismiss messaging notice"
        />
      )}
    </div>
  );
}
