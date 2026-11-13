import { Suspense, lazy, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { CanopyTerminal, type CanopyStreamState } from "@/components/Canopy/CanopyTerminal";
import { assistantTerminalApi } from "@/services/assistantSubject";
import { GLOBAL_ASSISTANT_HISTORY_ID } from "@/store/commandHistoryStore";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { AgentDirectorySubject } from "@shared/types/agentDirectory";
import type { GlobalAssistantInputStamp } from "@shared/types/ipc/help";
import {
  refusalReason,
  type AssistantSendAttempt,
  type AssistantSendFailure,
  type AssistantSendKind,
} from "./useAssistantSendFailure";

const LazyHybridInputBar = lazy(() =>
  import("@/components/Terminal/HybridInputBar").then((m) => ({ default: m.HybridInputBar }))
);

const NO_STREAM: CanopyStreamState = { watchId: null, ended: false, secretPrompt: false };

// Said in main's words where main refuses, so a refusal the pane catches first reads the same.
const INPUT_ELSEWHERE_REASON = "Another window has this assistant's input.";
const NO_INPUT_REASON = "No window has this assistant's input.";
const ENDED_REASON = "That assistant isn't running any more.";
const NOT_READY_REASON = "The assistant's terminal isn't ready yet.";

/**
 * The live terminal and this window's composer for one run under one input
 * ownership. Keyed by both, so taking or losing input opens a fresh stream:
 * a send queued through the old one is refused by main, never re-sent here.
 */
export function GlobalAssistantTerminal({
  subject,
  stamp,
  agentId,
  inputOwner,
  sendFailure,
  startSend,
  canClaimInput,
  onClaimInput,
}: {
  subject: AgentDirectorySubject;
  stamp: GlobalAssistantInputStamp | null;
  agentId: BuiltInAgentId | undefined;
  inputOwner: string | null;
  sendFailure: AssistantSendFailure | null;
  startSend: (kind: AssistantSendKind, runKey: string) => AssistantSendAttempt;
  canClaimInput: boolean;
  onClaimInput: () => void;
}) {
  const [api] = useState(() => assistantTerminalApi(subject, stamp ?? undefined));
  useEffect(() => () => api.dispose(), [api]);
  const [stream, setStream] = useState<CanopyStreamState>(NO_STREAM);

  const runKey = `${subject.terminalId}:${subject.incarnation}`;
  // What the composer needs to take Enter, so a banner never points at a key it won't take.
  const canType = stamp !== null && stream.watchId !== null && !stream.secretPrompt;

  // The stream to type through, or why there is none: a refusal says which.
  const typingTarget = (): { watchId: number } | { reason: string } => {
    if (!stamp) return { reason: inputOwner === null ? NO_INPUT_REASON : INPUT_ELSEWHERE_REASON };
    if (stream.watchId === null) {
      return { reason: stream.ended ? ENDED_REASON : NOT_READY_REASON };
    }
    return { watchId: stream.watchId };
  };

  // The draft clears only once main took the text; a refused send leaves it
  // and says so.
  const submit = async (text: string, imagePaths?: readonly string[]): Promise<boolean> => {
    const attempt = startSend("message", runKey);
    const target = typingTarget();
    if ("reason" in target) {
      attempt.failed(target.reason);
      return false;
    }
    try {
      await api.terminalSubmit(
        target.watchId,
        text,
        imagePaths && imagePaths.length > 0 ? [...imagePaths] : undefined
      );
    } catch (error) {
      attempt.failed(refusalReason(error));
      return false;
    }
    attempt.sent();
    return true;
  };

  const sendKey = (key: string) => {
    const attempt = startSend("key", runKey);
    const target = typingTarget();
    if ("reason" in target) {
      attempt.failed(target.reason);
      return;
    }
    api.terminalSendKey(target.watchId, key).then(attempt.sent, (error: unknown) => {
      attempt.failed(refusalReason(error));
    });
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface-canvas">
      <CanopyTerminal
        runId={subject.terminalId}
        spawnedAt={subject.incarnation}
        api={api}
        onStreamChange={setStream}
      />
      {sendFailure && (
        <div className="shrink-0 px-3 pb-2">
          <Callout
            severity="error"
            size="compact"
            role="status"
            title={
              sendFailure.kind === "message"
                ? "Couldn't send to assistant"
                : "Couldn't send key to assistant"
            }
            data-testid="help-global-send-failed"
          >
            <p>{sendFailure.reason}</p>
            {sendFailure.kind === "message" && (
              <p>
                {!stamp
                  ? "Your message is still in the box; take input to send it again."
                  : canType
                    ? "Your message is still in the box; press Enter to try again."
                    : "Your message is still in the box."}
              </p>
            )}
          </Callout>
        </div>
      )}
      <div data-keybindings-isolated="" className="contents">
        <Suspense fallback={null}>
          <LazyHybridInputBar
            isolated
            terminalId={subject.terminalId}
            cwd=""
            agentId={agentId}
            disabled={!canType}
            // No project's: its prompts are kept apart, offered beside every project's.
            historyProjectId={GLOBAL_ASSISTANT_HISTORY_ID}
            onSend={({ text, imagePaths }) => void submit(text, imagePaths)}
            submitText={submit}
            onSendKey={sendKey}
          />
        </Suspense>
      </div>
      {/* Where typing would happen, so the way to type sits beside the reason you can't. */}
      {!stamp && (
        <div
          className="flex shrink-0 items-center gap-2 px-3.5 pb-2"
          data-testid="help-global-input-elsewhere"
        >
          <p className="min-w-0 flex-1 text-xs text-text-secondary">
            {inputOwner === null
              ? "No window has this assistant's input"
              : "Another window has this assistant's input"}
          </p>
          <Button
            variant="outline"
            size="xs"
            onClick={onClaimInput}
            disabled={!canClaimInput}
            data-testid="help-global-take-input"
          >
            Take input
          </Button>
        </div>
      )}
    </div>
  );
}
