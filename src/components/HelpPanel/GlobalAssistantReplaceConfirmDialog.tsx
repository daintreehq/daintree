import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { getAgentConfig } from "@/config/agents";
import { GLOBAL_ASSISTANT_SLOT } from "@shared/config/globalAssistantSessions";
import { getViewHostId } from "@/hooks/useHostConnection";
import { notify } from "@/lib/notify";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { useFocusStore } from "@/store/focusStore";
import {
  takeGlobalAssistantReplacement,
  useGlobalAssistantReplaceConfirmStore,
} from "@/store/globalAssistantReplaceConfirmStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import { logWarn } from "@/utils/logger";

/** Read-time gate: a plugin raises this while the person may be typing elsewhere. */
const CONFIRM_COOLDOWN_MS = 1_200;

function agentName(agentId: string): string {
  return getAgentConfig(agentId)?.name ?? agentId;
}

/**
 * Replace the global assistant as the person just approved (#18140), and show
 * it where they approved it, as Clear conversation does. Only the request
 * still waiting is acted on, only from a view still on screen, and main
 * refuses it if the run they were shown has changed since. The keyboard stays
 * where the closing dialog returns it.
 */
export async function approveGlobalAssistantReplacement(requestId: string): Promise<void> {
  const request = takeGlobalAssistantReplacement(requestId);
  if (!request || isProjectViewCached() || getViewHostId() !== null) return;
  suppressSidebarResizes();
  // A panel tucked away by the focus gesture stays parked while that flag stands.
  useFocusStore.getState().clearAssistantGesture();
  const panel = useHelpPanelStore.getState();
  // A hand-off replaces the first session's run until choosing the one that
  // coordinates lands (#18137), so that is the session shown.
  panel.selectGlobal(null, GLOBAL_ASSISTANT_SLOT);
  panel.setOpen(true);
  // Nothing here asked for focus, so a pane mounting now has none to serve.
  useHelpPanelStore.setState((s) => ({ globalFocusHandledThrough: s.focusRequest }));
  try {
    await window.electron.help.replaceGlobalAssistant({
      agentId: request.agentId,
      prompt: request.prompt,
      expected: request.expected,
    });
  } catch (err) {
    // Stopped while starting, here or in another window: nothing went wrong.
    if (clientErrorCode(err) === "CANCELLED") return;
    logWarn("[GlobalAssistant] replacement failed", { code: clientErrorCode(err) });
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "error",
      title: "Couldn't replace global assistant",
      message: clientErrorText(
        err,
        "Its new agent didn't start. Start the global assistant again from the Assistant panel."
      ),
    });
  }
}

/**
 * Singleton dialog for a plugin's hand-off to the global assistant (#18140).
 * Nothing stops until the person approves; declining leaves the run as it is.
 */
export function GlobalAssistantReplaceConfirmDialog() {
  const current = useGlobalAssistantReplaceConfirmStore((state) => state.current);

  if (current === null) {
    return (
      <ConfirmDialog
        isOpen={false}
        title=""
        confirmLabel="Replace global assistant"
        onConfirm={() => {}}
        variant="destructive"
      />
    );
  }

  const { requestId, pluginName, currentAgentId, expected } = current;
  const incoming = agentName(current.agentId);
  const replacing = expected.phase !== "absent";
  const outgoing = currentAgentId ? agentName(currentAgentId) : "Its agent";
  // Beside a second session, the one replaced is named: always the first.
  const target = current.namesSession ? "global assistant session 1" : "the global assistant";

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => takeGlobalAssistantReplacement(requestId)}
      onConfirm={() => void approveGlobalAssistantReplacement(requestId)}
      title={
        current.namesSession
          ? replacing
            ? "Replace global assistant session 1?"
            : "Start a new conversation in global assistant session 1?"
          : replacing
            ? "Replace the global assistant?"
            : "Start a new global assistant conversation?"
      }
      description={
        replacing
          ? `${pluginName} asks to move ${target} to ${incoming}. ${outgoing} stops in every window and ${incoming} starts a new conversation from the message below.`
          : `${pluginName} asks to start ${target} in ${incoming}, from the message below. Any conversation it kept for its next start is cleared.`
      }
      confirmLabel={replacing ? "Replace global assistant" : "Start global assistant"}
      cancelLabel="Cancel"
      variant="destructive"
      initialFocus="cancel"
      hasPreview
      focusResetKey={requestId}
      bodyResetKey={requestId}
      confirmCooldownMs={CONFIRM_COOLDOWN_MS}
      cooldownKey={requestId}
    >
      <div
        className="max-h-60 overflow-y-auto font-mono text-xs break-words whitespace-pre-wrap text-text-primary"
        data-testid="global-assistant-replace-prompt"
      >
        {current.prompt}
      </div>
    </ConfirmDialog>
  );
}
