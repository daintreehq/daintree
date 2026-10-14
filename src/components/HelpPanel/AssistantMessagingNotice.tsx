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

const ENDED_TITLE = "Stopped accepting messages from other machines";

interface AssistantMessagingNoticeProps {
  state: AssistantMessagingState | null;
  refusal: AssistantMessagingEnrollDenial | null;
  /** The lane `state` was read for; a dismissal holds for that lane's ending only. */
  laneKey: string | null;
  onDismissRefusal: () => void;
}

/**
 * Says when a lane stopped accepting messages from other machines without the
 * person turning it off, so nobody is left thinking it's still reachable.
 *
 * The words are spoken from a polite live region that is mounted from the
 * start and holds nothing but the text; the banners are drawn outside it,
 * silent, so the notice is announced once when it appears, wherever focus is.
 */
export function AssistantMessagingNotice({
  state,
  refusal,
  laneKey,
  onDismissRefusal,
}: AssistantMessagingNoticeProps) {
  // Per lane, so dismissing one lane's ending never brings back another's.
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const ended = state?.available ? state.lane.ended : null;
  const lane = laneKey ?? "";
  const endingKey = ended ? `${ended.at}\u0000${ended.reason}` : null;
  const showEnded = ended !== null && endingKey !== dismissed[lane];
  const showRefusal = refusal !== null && !showEnded;
  const announcement = showEnded
    ? `${ENDED_TITLE}. ${ENDED_DESCRIPTION[ended.reason]}`
    : showRefusal
      ? REFUSAL_TITLE[refusal]
      : "";

  return (
    <div data-testid="assistant-messaging-notice">
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {showEnded && (
        <InlineStatusBanner
          severity="warning"
          layout="inline"
          animated={false}
          role="status"
          ariaLive="off"
          title={ENDED_TITLE}
          description={ENDED_DESCRIPTION[ended.reason]}
          onClose={() => setDismissed((prev) => ({ ...prev, [lane]: endingKey ?? "" }))}
          closeAriaLabel="Dismiss messaging notice"
        />
      )}
      {showRefusal && (
        <InlineStatusBanner
          severity="neutral"
          layout="inline"
          animated={false}
          role="status"
          ariaLive="off"
          title={REFUSAL_TITLE[refusal]}
          onClose={onDismissRefusal}
          closeAriaLabel="Dismiss messaging notice"
        />
      )}
    </div>
  );
}
