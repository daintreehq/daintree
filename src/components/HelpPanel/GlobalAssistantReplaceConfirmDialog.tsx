import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { getAgentConfig } from "@/config/agents";
import { notify } from "@/lib/notify";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
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
 * still waiting is acted on, and main refuses it if the run they were shown
 * has changed since.
 */
export async function approveGlobalAssistantReplacement(requestId: string): Promise<void> {
  const request = takeGlobalAssistantReplacement(requestId);
  if (!request) return;
  suppressSidebarResizes();
  useFocusStore.getState().clearAssistantGesture();
  const panel = useHelpPanelStore.getState();
  panel.selectGlobal(null);
  panel.setOpen(true);
  panel.requestFocus();
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
      message: clientErrorText(err, "The global assistant didn't start on the agent asked for."),
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

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => takeGlobalAssistantReplacement(requestId)}
      onConfirm={() => void approveGlobalAssistantReplacement(requestId)}
      title={
        replacing ? "Replace the global assistant?" : "Start a new global assistant conversation?"
      }
      description={
        replacing
          ? `${pluginName} asks to continue the global assistant in ${incoming}. ${outgoing} stops in every window and ${incoming} starts a new conversation from the message below.`
          : `${pluginName} asks to start the global assistant in ${incoming}, from the message below. Any conversation it kept for its next start is cleared.`
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
