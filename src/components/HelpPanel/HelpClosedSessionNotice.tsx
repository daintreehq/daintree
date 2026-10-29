import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import {
  CLOSED_SESSION_FIND_LABEL,
  CLOSED_SESSION_REOPEN_LABEL,
  type ClosedSessionNotice,
  type ClosedSessionRecovery,
} from "./useHelpSessionLanes";

const NOTICE_ATTR = "data-help-closed-session-notice";

interface HelpClosedSessionNoticeProps {
  notice: ClosedSessionNotice;
  onReopen: (recovery: ClosedSessionRecovery) => void;
  onDismiss: () => void;
}

/**
 * The way back from closing a session tab (#15385), in place of asking first. It
 * sits under the assistant's terminal, in the panel the close happened in, and
 * leaves on the shared undo window — held while the pointer or focus is on it.
 * It never takes focus, so closing several tabs with Delete keeps going. Once it
 * is gone, "Resume a past session…" still lists the conversation.
 */
export function HelpClosedSessionNotice({
  notice,
  onReopen,
  onDismiss,
}: HelpClosedSessionNoticeProps) {
  const { recovery } = notice;
  // Dismissed from the keyboard, the notice would hand focus to the first control
  // in the panel — the header. The tab strip is where the user was working.
  const handleDismiss = () => {
    const focused = document.activeElement;
    const inNotice = focused instanceof HTMLElement && focused.closest(`[${NOTICE_ATTR}]`);
    if (inNotice) {
      inNotice
        .closest("aside")
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
    }
    onDismiss();
  };
  return (
    <InlineStatusBanner
      // A second close is a new notice with a fresh window, not an edit of this one.
      key={notice.id}
      severity="neutral"
      layout="inline"
      animated={false}
      role="status"
      ariaLive="polite"
      data-testid="help-closed-session-notice"
      rootAttributes={{ [NOTICE_ATTR]: true }}
      title={`${notice.label} closed`}
      action={{
        id: "reopen-closed-session",
        label: recovery.kind === "reopen" ? CLOSED_SESSION_REOPEN_LABEL : CLOSED_SESSION_FIND_LABEL,
        onClick: () => onReopen(recovery),
      }}
      onClose={handleDismiss}
      autoDismissAfter={UNDO_TOAST_DURATION_MS}
      closeAriaLabel="Dismiss session closed notice"
    />
  );
}
