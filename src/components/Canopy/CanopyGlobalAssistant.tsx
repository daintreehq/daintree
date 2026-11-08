import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { GlobalAssistantTerminal } from "@/components/HelpPanel/GlobalAssistantTerminal";
import { useAssistantSendFailure } from "@/components/HelpPanel/useAssistantSendFailure";
import { useGlobalAssistant } from "@/components/HelpPanel/useGlobalAssistant";
import { useGlobalAssistantIdentity } from "@/store/assistantIdentityStore";
import { displayIdentityLabel } from "@shared/utils/displayIdentity";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { isSameAssistantRun } from "@shared/types/agentDirectory";
import type { GlobalAssistantInputStamp } from "@shared/types/ipc/help";
import { CanopyAssistantPaneFrame, CanopyAssistantPaneHead } from "./CanopyAssistantList";
import type { CanopyAssistantItem } from "./canopyAssistants";

function subscribeViewCache(onChange: () => void): () => void {
  return subscribeProjectViewLifecycle(() => onChange());
}

/** Escape here is the agent's or its composer's: it must not also close Canopy around them. */
function keepEscape(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key === "Escape") event.stopPropagation();
}

/**
 * This machine's global Daintree Assistant in Canopy (#16214): docked beside
 * the selected agent, or in the pane when its own row is selected. The view
 * attaches while it is shown and types under the input it holds, as the
 * Assistant panel does; input the panel behind Canopy holds comes here and
 * goes back to it, and input another window holds is only taken by asking.
 * Nothing starts it but the person pressing Start.
 */
export function CanopyGlobalAssistant({
  item,
  refusal,
  workOf,
  onOpen,
  onShowWork,
}: {
  /** The directory's row for this machine's global assistant, while it lists one. */
  item: CanopyAssistantItem | null;
  /** Why the last "Open in Assistant" didn't, in words, and for which assistant. */
  refusal: { id: string; text: string } | null;
  /** The assistant whose work the inbox is narrowed to, if any. */
  workOf: string | null;
  onOpen: (item: CanopyAssistantItem) => void;
  onShowWork: (item: CanopyAssistantItem) => void;
}) {
  const viewCached = useSyncExternalStore(subscribeViewCache, isProjectViewCached);
  // A window bound to another host reaches that host's assistants, not this one's.
  const boundElsewhere = getViewHostId() !== null;
  const identity = useGlobalAssistantIdentity();
  const { view, attachmentId, error, start, claimInput } = useGlobalAssistant(
    !viewCached && !boundElsewhere,
    undefined,
    true
  );
  const [starting, setStarting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const subject = view?.phase === "running" ? (view.subject ?? null) : null;
  const holdsInput = attachmentId !== null && view?.inputOwner === attachmentId;
  const stamp: GlobalAssistantInputStamp | null =
    holdsInput && attachmentId !== null && view
      ? { attachmentId, inputEpoch: view.inputEpoch }
      : null;
  // Keyed by the input it types under, as the Assistant panel's is: taking or
  // losing input opens a fresh stream, and anything queued under the old is refused.
  const paneKey = subject
    ? `${subject.terminalId}:${subject.incarnation}:${stamp ? stamp.inputEpoch : "read"}`
    : null;
  const runKey = subject ? `${subject.terminalId}:${subject.incarnation}` : null;
  const { failure: sendFailure, start: startSend } = useAssistantSendFailure(runKey);
  const agentId = view?.agentId ?? null;
  const composerAgentId = agentId && isBuiltInAgentId(agentId) ? agentId : undefined;
  // The directory's row only for the run on screen: a read from before a restart names the last one.
  const shownItem = item !== null && isSameAssistantRun(item.subject, subject) ? item : null;

  // Taking input remounts the terminal under it, which drops the pressed
  // button; the keyboard follows to the composer.
  const [focusAsk, setFocusAsk] = useState(0);
  useEffect(() => {
    if (focusAsk === 0) return;
    let frame = 0;
    const attempt = (tries: number) => {
      const editor = rootRef.current?.querySelector<HTMLElement>(".cm-content");
      if (editor) {
        editor.focus({ preventScroll: true });
        return;
      }
      if (tries < 60) frame = requestAnimationFrame(() => attempt(tries + 1));
    };
    frame = requestAnimationFrame(() => attempt(0));
    return () => cancelAnimationFrame(frame);
  }, [focusAsk, paneKey]);

  const handleStart = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await start();
    } finally {
      setStarting(false);
    }
  };

  const terminal =
    subject !== null && paneKey !== null && view !== null ? (
      <div className="contents" onKeyDown={keepEscape}>
        <GlobalAssistantTerminal
          key={paneKey}
          subject={subject}
          stamp={stamp}
          agentId={composerAgentId}
          inputOwner={view.inputOwner}
          sendFailure={sendFailure}
          startSend={startSend}
          canClaimInput={attachmentId !== null}
          onClaimInput={() => {
            void claimInput().then((claimed) => {
              if (claimed) setFocusAsk((ask) => ask + 1);
            });
          }}
        />
      </div>
    ) : null;

  const errorCallout = error !== null && (
    <div className="shrink-0 pb-2">
      <Callout severity="error" size="compact" title="Global assistant">
        {error}
      </Callout>
    </div>
  );

  // One tree whatever is known: the session's frame keeps its place, so the
  // directory's row arriving after the stream opened never reopens it.
  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="canopy-global-assistant"
    >
      {errorCallout}
      {shownItem !== null ? (
        <CanopyAssistantPaneHead
          item={shownItem}
          refusal={refusal?.id === shownItem.id ? refusal.text : null}
          onOpen={() => onOpen(shownItem)}
          showingWork={workOf === shownItem.id}
          onShowWork={() => onShowWork(shownItem)}
        />
      ) : (
        // Until the directory lists the run on screen, or while none runs.
        <div className="flex h-9 min-w-0 shrink-0 items-center gap-2 px-1 text-xs select-none">
          <span className="min-w-0 shrink-0 font-medium text-text-primary">
            {/* The store holds the bound host's personas, not this machine's. */}
            {boundElsewhere
              ? "Daintree Assistant"
              : displayIdentityLabel(identity, "Daintree Assistant")}
          </span>
          <span className="min-w-0 flex-1 truncate text-text-secondary">Global</span>
        </div>
      )}
      <CanopyAssistantPaneFrame>
        {boundElsewhere ? (
          <p className="px-6 py-8 text-center text-xs text-text-secondary">
            This window runs on another host. Open the global assistant from a window on this
            machine.
          </p>
        ) : view === null ? (
          <div className="flex-1" aria-busy="true" />
        ) : view.phase === "absent" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="max-w-[34ch] text-sm text-text-secondary">
              Start it to direct these agents from here. It picks up its last conversation when
              there is one.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleStart()}
              disabled={starting}
              data-testid="canopy-global-start"
            >
              <Globe aria-hidden="true" />
              Start global assistant
            </Button>
          </div>
        ) : view.phase === "launching" ? (
          <p
            role="status"
            className="animate-pulse-delayed px-6 py-8 text-center text-xs text-text-secondary"
          >
            Starting the global assistant…
          </p>
        ) : terminal === null ? (
          // Running with no terminal to watch: its PTY is being brought back, or couldn't be.
          <p role="status" className="px-6 py-8 text-center text-xs text-text-secondary">
            The global assistant's terminal isn't available. Clear the conversation from the
            Assistant panel if it doesn't come back.
          </p>
        ) : (
          terminal
        )}
      </CanopyAssistantPaneFrame>
    </div>
  );
}
