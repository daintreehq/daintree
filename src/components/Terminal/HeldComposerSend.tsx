import { useId, useState, type ReactElement } from "react";
import { Clock } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { CopyButton } from "@/components/ui/CopyButton";
import { DismissButton } from "@/components/ui/DismissButton";
import { composerHoldClient } from "@/clients/composerHoldClient";
import { pluralize } from "@/lib/pluralize";
import { logWarn } from "@/utils/logger";
import { useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { requestPaneFocus } from "./paneFocusRequest";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { ComposerHoldDropReason } from "@shared/types/ipc/composerHold";
import { isPtyPanel } from "@shared/types/panel";

const DROP_REASON: Record<ComposerHoldDropReason, string> = {
  typed: "input reached the terminal first",
  restarted: "the agent restarted",
  closed: "the panel was closed",
  ended: "the agent's terminal ended",
  expired: "it waited an hour",
  stopped: "the panel's notices were stopped",
  "driven-elsewhere": "another screen took over driving this project",
  "input-blocked": "the panel couldn't take input",
  unconfirmed: "Daintree couldn't confirm it reached the agent",
};

/** What the pane was last seen waiting on, when it isn't its prompt. */
const NOT_AT_PROMPT: Partial<Record<string, string>> = {
  question: "a question",
  approval: "an approval",
  error: "an error",
};

/** Prompts that take typed text as their answer: Send now says so before it types. */
const ANSWERED_BY_TEXT = new Set(["question", "approval"]);

/** The first line of what was sent, for the row: the whole text comes back on Edit. */
function previewOf(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.trim().slice(0, 200);
}

/**
 * Put a held send's text back in the pane's composer, ahead of anything typed
 * since, and hand the composer the keyboard.
 */
function restoreToDraft(terminalId: string, projectId: string | undefined, text: string): void {
  const inputs = useTerminalInputStore.getState();
  const draft = inputs.getDraftInput(terminalId, projectId);
  inputs.setDraftInput(terminalId, draft.trim() === "" ? text : `${text}\n\n${draft}`, projectId);
  inputs.bumpExternalDraftRevision();
  requestPaneFocus(terminalId, "hybridInput");
}

export interface HeldComposerSendRowProps {
  terminalId: string;
  agentId?: string;
  /** The pane's composer is there to take the text back: otherwise it is offered to copy. */
  canEdit: boolean;
  /** The panel can't take input: Send now drops the send, saying why, rather than typing it. */
  inputBlocked?: boolean;
}

/**
 * The pane composer's send held for its agent's next prompt (#16379), in the
 * composer's area: what it is waiting on, Send now to stop waiting (#16745),
 * Edit to take it back into the composer, and Withdraw. Once dropped it says
 * why and keeps the text to take back until dismissed.
 */
export function HeldComposerSendRow({
  terminalId,
  agentId,
  canEdit,
  inputBlocked = false,
}: HeldComposerSendRowProps): ReactElement | null {
  const held = useHeldComposerSendStore((s) => s.held[terminalId]);
  const dropped = useHeldComposerSendStore((s) => s.dropped[terminalId]);
  const refused = useHeldComposerSendStore((s) => s.refused[terminalId] === true);
  const waitingReason = usePanelStore((s) => {
    const panel = s.panelsById[terminalId];
    if (!panel || !isPtyPanel(panel) || panel.agentState !== "waiting") return undefined;
    return panel.waitingReason;
  });
  const waitingOn = waitingReason === undefined ? undefined : NOT_AT_PROMPT[waitingReason];
  const projectId = useProjectStore((s) => s.currentProject?.id);
  const [busy, setBusy] = useState(false);
  const sendNowHintId = useId();

  if (held === undefined && dropped === undefined) return null;
  const agentName =
    (agentId !== undefined ? getEffectiveAgentConfig(agentId)?.name : undefined) ?? "the agent";

  const withdraw = async (thenEdit: boolean): Promise<void> => {
    if (held === undefined || busy) return;
    setBusy(true);
    try {
      const withdrawn = await composerHoldClient.withdraw(terminalId, held.token);
      if (withdrawn && thenEdit) restoreToDraft(terminalId, projectId, held.text);
    } catch (err) {
      logWarn("[HeldComposerSend] withdraw failed", { terminalId, error: err });
    } finally {
      setBusy(false);
    }
  };

  // Main types it, or drops it saying why, and its push moves the row on.
  const sendNow = async (): Promise<void> => {
    if (held === undefined || busy) return;
    setBusy(true);
    try {
      await composerHoldClient.sendNow(terminalId, held.token, inputBlocked);
    } catch (err) {
      logWarn("[HeldComposerSend] send now failed", { terminalId, error: err });
    } finally {
      setBusy(false);
    }
  };

  if (held !== undefined) {
    const sending = held.status === "sending";
    const answers =
      waitingReason !== undefined && ANSWERED_BY_TEXT.has(waitingReason) ? waitingReason : null;
    const images =
      held.imagePaths.length > 0 ? ` · ${pluralize(held.imagePaths.length, "image")}` : "";
    const status = sending
      ? "Sending the held message…"
      : waitingOn !== undefined
        ? `Held: ${agentName} is waiting on ${waitingOn}, not its prompt`
        : `Held until ${agentName} is back at its prompt`;
    return (
      <Callout
        severity="neutral"
        size="compact"
        icon={Clock}
        role="status"
        data-testid="held-composer-send"
        className="mx-2 mb-1"
        action={
          sending ? undefined : (
            <div className="flex items-center gap-1">
              {canEdit && (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => void withdraw(true)}
                >
                  Edit
                </Button>
              )}
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                aria-describedby={answers !== null ? sendNowHintId : undefined}
                onClick={() => void sendNow()}
              >
                Send now
              </Button>
            </div>
          )
        }
        dismiss={
          sending ? undefined : (
            <DismissButton
              aria-label="Withdraw held message"
              tooltip="Withdraw"
              disabled={busy}
              onClick={() => void withdraw(false)}
            />
          )
        }
      >
        <p>{status}</p>
        <p className="truncate text-text-secondary">
          {previewOf(held.text)}
          {images}
        </p>
        {answers !== null && !sending && (
          <p id={sendNowHintId} className="text-text-secondary">
            Send now types it into that {answers}.
          </p>
        )}
        {refused && !sending && (
          <p className="text-text-secondary">
            {canEdit
              ? "Send it now, edit it or withdraw it to send another."
              : "Send it now or withdraw it to send another."}
          </p>
        )}
      </Callout>
    );
  }

  if (dropped === undefined) return null;
  return (
    <Callout
      severity="warning"
      size="compact"
      role="status"
      data-testid="held-composer-send-dropped"
      className="mx-2 mb-1"
      action={
        canEdit ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              useHeldComposerSendStore.getState().clearDropped(terminalId);
              restoreToDraft(terminalId, projectId, dropped.text);
            }}
          >
            Edit
          </Button>
        ) : (
          <CopyButton text={dropped.text} label="Copy message" variant="ghost" size="xs" />
        )
      }
      dismiss={
        <DismissButton
          aria-label="Dismiss unsent held message"
          onClick={() => useHeldComposerSendStore.getState().clearDropped(terminalId)}
        />
      }
    >
      <p>Held message not sent: {DROP_REASON[dropped.reason]}</p>
      <p className="truncate text-text-secondary">{previewOf(dropped.text)}</p>
    </Callout>
  );
}
