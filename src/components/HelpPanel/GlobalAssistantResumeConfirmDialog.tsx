import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { getAgentConfig } from "@/config/agents";
import { globalAssistantSessionNumber } from "@shared/config/globalAssistantSessions";
import { getViewHostId } from "@/hooks/useHostConnection";
import { notify } from "@/lib/notify";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { useFocusStore } from "@/store/focusStore";
import {
  takeGlobalAssistantResume,
  useGlobalAssistantResumeConfirmStore,
  type PendingGlobalAssistantResume,
} from "@/store/globalAssistantResumeConfirmStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import { logWarn } from "@/utils/logger";

/** Read-time gate for a plugin's request: it arrives while the person may be typing elsewhere. */
const CONFIRM_COOLDOWN_MS = 1_200;

/**
 * Reopen the earlier conversation the person just approved (#18169), and show
 * the session it opens in. Only the request still waiting is acted on, only
 * from a view still on screen, and main refuses it if the session they were
 * shown has changed since.
 */
export async function approveGlobalAssistantResume(requestId: string): Promise<void> {
  const request = takeGlobalAssistantResume(requestId);
  if (!request || isProjectViewCached() || getViewHostId() !== null) return;
  suppressSidebarResizes();
  // A panel tucked away by the focus gesture stays parked while that flag stands.
  useFocusStore.getState().clearAssistantGesture();
  const panel = useHelpPanelStore.getState();
  panel.selectGlobal(null, request.slot);
  panel.setOpen(true);
  // Nothing here asked for focus, so a pane mounting now has none to serve.
  useHelpPanelStore.setState((s) => ({ globalFocusHandledThrough: s.focusRequest }));
  try {
    await window.electron.help.resumeGlobalAssistantConversation({
      slot: request.slot,
      agentSessionId: request.agentSessionId,
      expected: request.expected,
    });
  } catch (err) {
    // Stopped while starting, here or in another window: nothing went wrong.
    if (clientErrorCode(err) === "CANCELLED") return;
    logWarn("[GlobalAssistant] resuming an earlier conversation failed", {
      code: clientErrorCode(err),
    });
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "error",
      title: "Couldn't reopen conversation",
      message: clientErrorText(
        err,
        "That conversation didn't open. Start the global assistant again to go back to the one it had."
      ),
    });
  }
}

/** What reopening does, for the dialog's body. */
function resumeConsequence(request: PendingGlobalAssistantResume): string {
  const agentName = getAgentConfig(request.agentId)?.name ?? request.agentId;
  const asker = request.pluginName
    ? `${request.pluginName} asks to reopen this conversation. `
    : "";
  const target = request.namesSession
    ? `Session ${globalAssistantSessionNumber(request.slot)}`
    : "The global assistant";
  const stops =
    request.expected.phase === "running"
      ? `${agentName} stops in every window and reopens it. Its current conversation stays in earlier conversations`
      : `${target} starts on it instead of any conversation it kept, which stays in earlier conversations`;
  return `${asker}${stops}. The workers it launched move to this conversation.`;
}

/**
 * Singleton dialog for reopening an earlier global conversation (#18169).
 * Nothing stops until the person approves; declining leaves the run as it is.
 */
export function GlobalAssistantResumeConfirmDialog() {
  const current = useGlobalAssistantResumeConfirmStore((state) => state.current);

  if (current === null) {
    return (
      <ConfirmDialog
        isOpen={false}
        title=""
        confirmLabel="Reopen conversation"
        onConfirm={() => {}}
        variant="destructive"
      />
    );
  }

  const { requestId, pluginName } = current;
  const session = current.namesSession
    ? ` in session ${globalAssistantSessionNumber(current.slot)}`
    : "";

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => takeGlobalAssistantResume(requestId)}
      onConfirm={() => void approveGlobalAssistantResume(requestId)}
      title={`Reopen this conversation${session}?`}
      description={resumeConsequence(current)}
      confirmLabel="Reopen conversation"
      cancelLabel="Cancel"
      variant={current.expected.phase === "running" ? "destructive" : "default"}
      initialFocus="cancel"
      focusResetKey={requestId}
      {...(pluginName !== null
        ? { confirmCooldownMs: CONFIRM_COOLDOWN_MS, cooldownKey: requestId }
        : {})}
    >
      <div
        className="text-sm break-words text-text-primary"
        data-testid="global-assistant-resume-title"
      >
        {current.title}
      </div>
    </ConfirmDialog>
  );
}
