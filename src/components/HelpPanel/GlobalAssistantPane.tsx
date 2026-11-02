import { Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, CircleStop, Ellipsis, Globe, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CanopyTerminal, type CanopyStreamState } from "@/components/Canopy/CanopyTerminal";
import { getAgentConfig } from "@/config/agents";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { assistantTerminalApi } from "@/services/assistantSubject";
import { useCanopyStore } from "@/store/canopyStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { isSameAssistantRun, type AgentDirectorySubject } from "@shared/types/agentDirectory";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { GlobalAssistantInputStamp, GlobalAssistantView } from "@shared/types/ipc/help";
import { useGlobalAssistant } from "./useGlobalAssistant";
import {
  refusalReason,
  useAssistantSendFailure,
  type AssistantSendAttempt,
  type AssistantSendFailure,
  type AssistantSendKind,
} from "./useAssistantSendFailure";
import { HEADER_ACTION_CLASS } from "./HelpPanelHeader";
import { TabAgentMark } from "./HelpSessionTabs";

const LazyHybridInputBar = lazy(() =>
  import("@/components/Terminal/HybridInputBar").then((m) => ({ default: m.HybridInputBar }))
);

const NO_STREAM: CanopyStreamState = { watchId: null, ended: false, secretPrompt: false };

// Said in main's words where main refuses, so a refusal the pane catches first reads the same.
const INPUT_ELSEWHERE_REASON = "Another window has this assistant's input.";
const NO_INPUT_REASON = "No window has this assistant's input.";
const ENDED_REASON = "That assistant isn't running any more.";
const NOT_READY_REASON = "The assistant's terminal isn't ready yet.";

function subscribeViewCache(onChange: () => void): () => void {
  return subscribeProjectViewLifecycle(() => onChange());
}

function runningSubject(view: GlobalAssistantView | null): AgentDirectorySubject | null {
  return view?.phase === "running" ? (view.subject ?? null) : null;
}

/** The run "Open in Assistant" chose is gone, whatever runs now. */
function chosenRunEnded(
  target: AgentDirectorySubject | null,
  view: GlobalAssistantView | null
): boolean {
  return target !== null && view !== null && !isSameAssistantRun(runningSubject(view), target);
}

/**
 * Whether the pane could type to the run `view` shows: not behind Canopy, and
 * showing the run "Open in Assistant" chose only once that run is seen running.
 */
function canTypeTo(
  canopyOpen: boolean,
  target: AgentDirectorySubject | null,
  view: GlobalAssistantView | null
): boolean {
  if (canopyOpen) return false;
  return target === null || isSameAssistantRun(runningSubject(view), target);
}

/**
 * The installation's one global Daintree Assistant, in the Assistant panel
 * (#14454). Main owns its run; this view attaches to read it while the pane is
 * on screen and lets go when it isn't, which never ends the run. Nothing here
 * starts a session except the person pressing Start.
 *
 * Every window shows the same terminal. One holds its input at a time: taken
 * from another window only by asking, and handed by main to a window that can
 * type when its holder goes. The pane types under the ownership it opened with,
 * so once input moves — even away and back — its stream is reopened and
 * anything still queued under the old ownership is refused by main. Each
 * window's composer keeps its own draft through all of that.
 */
export function GlobalAssistantPane({
  isVisible,
  controlsHost,
  onOpenDocs,
  focusHandledThrough = -1,
}: {
  isVisible: boolean;
  /**
   * A focus request already served elsewhere. Picking Global on the scope switch
   * leaves the keyboard on the switch, where arrow keys keep working; only a
   * request made after that (or before, from a command) brings it here.
   */
  focusHandledThrough?: number;
  /** The panel header's slot for this run's agent and menu; nothing is drawn there without one. */
  controlsHost: HTMLElement | null;
  onOpenDocs: () => void;
}) {
  const isOpen = useHelpPanelStore((s) => s.isOpen);
  const target = useHelpPanelStore((s) => s.globalTarget);
  const focusRequest = useHelpPanelStore((s) => s.focusRequest);
  const passiveFocusHandledThrough = useHelpPanelStore((s) => s.globalFocusHandledThrough);
  const canopyOpen = useCanopyStore((s) => s.isOpen);
  const viewCached = useSyncExternalStore(subscribeViewCache, isProjectViewCached);
  // A window bound to another host reaches that host's assistants, not this one's.
  const boundElsewhere = getViewHostId() !== null;
  const active = isOpen && isVisible && !viewCached && !boundElsewhere;
  // Attached behind Canopy or an ended run, the pane can't type, so input
  // nobody holds passes it over.
  const { view, attachmentId, error, start, claimInput, restart, discard } = useGlobalAssistant(
    active,
    (shown) => canTypeTo(canopyOpen, target, shown)
  );
  const [pendingConfirm, setPendingConfirm] = useState<{
    kind: "restart" | "discard";
    generation: number;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  // As the header's own menu: Escape closes the open menu, not the panel.
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  useEscapeStack(isMenuOpen, () => setIsMenuOpen(false));
  const rootRef = useRef<HTMLDivElement>(null);

  const subject = runningSubject(view);
  // The run "Open in Assistant" chose, gone by now: said, and its successor
  // never put in its place.
  const targetEnded = chosenRunEnded(target, view);
  const shown = targetEnded ? null : subject;
  const holdsInput = attachmentId !== null && view?.inputOwner === attachmentId;
  const stamp: GlobalAssistantInputStamp | null =
    holdsInput && attachmentId !== null && view
      ? { attachmentId, inputEpoch: view.inputEpoch }
      : null;
  const paneKey = shown
    ? `${shown.terminalId}:${shown.incarnation}:${stamp ? stamp.inputEpoch : "read"}`
    : null;
  // Held here, not in the terminal: input moving remounts that.
  const runKey = shown ? `${shown.terminalId}:${shown.incarnation}` : null;
  const { failure: sendFailure, start: startSend } = useAssistantSendFailure(runKey);

  const agentId = view?.agentId ?? null;
  const agentName = agentId ? (getAgentConfig(agentId)?.name ?? agentId) : null;
  const composerAgentId = agentId && isBuiltInAgentId(agentId) ? agentId : undefined;

  // Shown or asked for focus, the keyboard comes here, as a lane's tab hands it
  // to its terminal: to the composer, else the terminal, else the pane's one
  // action. The request may predate this lazily loaded pane, so none counts as
  // handled before it has mounted. A project switch bringing Global back
  // serves the request it found, mounted or not: the switch placed the keyboard.
  const handledFocusRef = useRef(focusHandledThrough);
  useEffect(() => {
    if (!isVisible || !isOpen) return;
    if (focusRequest <= Math.max(handledFocusRef.current, passiveFocusHandledThrough)) return;
    let frame = 0;
    const attempt = (tries: number) => {
      const root = rootRef.current;
      if (!root) return;
      if (root.contains(document.activeElement)) {
        handledFocusRef.current = focusRequest;
        return;
      }
      const editor = root.querySelector<HTMLElement>(".cm-content");
      if (editor) {
        editor.focus({ preventScroll: true });
        handledFocusRef.current = focusRequest;
        return;
      }
      const fallback =
        root.querySelector<HTMLElement>("[data-canopy-terminal] textarea") ??
        root.querySelector<HTMLElement>("[data-global-focus-target]");
      if (fallback && (tries > 30 || fallback.matches("[data-global-focus-target]"))) {
        fallback.focus({ preventScroll: true });
        handledFocusRef.current = focusRequest;
        return;
      }
      if (tries < 120) frame = requestAnimationFrame(() => attempt(tries + 1));
    };
    frame = requestAnimationFrame(() => attempt(0));
    return () => cancelAnimationFrame(frame);
  }, [isVisible, isOpen, focusRequest, paneKey, passiveFocusHandledThrough]);

  const handleStart = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await start();
    } finally {
      setStarting(false);
    }
  };

  // Restart and stop act on the run this pane shows, never on a successor it
  // is hiding behind "ended".
  const controllable = view?.phase === "running" && !targetEnded;
  const generation = view?.generation ?? 0;

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="help-global-assistant-pane"
    >
      {controlsHost &&
        createPortal(
          <>
            {/* The run's agent, set apart from the switch by its mark so it can't read
                as a third option. */}
            <span
              className="flex min-w-0 flex-1 items-center gap-1.5 pl-1 text-xs text-text-secondary"
              data-testid="help-global-agent"
            >
              {agentId && <TabAgentMark agentId={agentId} />}
              <span className="truncate">{agentName ?? ""}</span>
            </span>
            <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={HEADER_ACTION_CLASS}
                      aria-label="More actions"
                      aria-haspopup="menu"
                      data-testid="help-global-more"
                    >
                      <Ellipsis aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">More actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                {controllable && (
                  <>
                    <DropdownMenuItem
                      destructive
                      onSelect={() => setPendingConfirm({ kind: "restart", generation })}
                    >
                      <RotateCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                      Restart conversation
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onSelect={onOpenDocs}>
                  <CircleHelp className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Open docs
                </DropdownMenuItem>
                {controllable && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      destructive
                      onSelect={() => setPendingConfirm({ kind: "discard", generation })}
                    >
                      <CircleStop className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                      Stop global assistant
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>,
          controlsHost
        )}

      {error !== null && (
        <div className="shrink-0 px-3 pb-2">
          <Callout severity="error" size="compact" title="Global assistant">
            {error}
          </Callout>
        </div>
      )}

      {boundElsewhere ? (
        <p className="px-6 py-8 text-center text-xs text-text-secondary">
          This window runs on another host. Open the global assistant from a window on this machine.
        </p>
      ) : targetEnded ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="max-w-[30ch] text-sm text-text-secondary">
            The global assistant session you opened has ended
          </p>
          <Button
            variant="outline"
            onClick={() => useHelpPanelStore.getState().selectGlobal(null)}
            data-testid="help-global-show-current"
            data-global-focus-target=""
          >
            Show the global assistant
          </Button>
        </div>
      ) : view === null ? (
        <div className="flex-1" aria-busy="true" />
      ) : view.phase === "absent" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
          <p className="max-w-[32ch] text-sm text-text-secondary">
            One assistant for every project and window. It picks up its last conversation when there
            is one.
          </p>
          <Button
            type="button"
            onClick={() => void handleStart()}
            disabled={starting}
            data-testid="help-global-start"
            data-global-focus-target=""
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
      ) : !shown || paneKey === null ? (
        // Running with no terminal to watch: its PTY is being brought back, or
        // couldn't be. Restart stays in the menu above either way.
        <p role="status" className="px-6 py-8 text-center text-xs text-text-secondary">
          The global assistant's terminal isn't available. Restart it from the menu if it doesn't
          come back.
        </p>
      ) : canopyOpen ? (
        <p className="px-6 py-8 text-center text-xs text-text-secondary">
          Canopy is open in this window. Close it to see the global assistant here.
        </p>
      ) : !active ? (
        // Hidden or cached, nothing streams: the draft is in the composer's store.
        <div className="flex-1" />
      ) : (
        <GlobalAssistantTerminal
          key={paneKey}
          subject={shown}
          stamp={stamp}
          agentId={composerAgentId}
          inputOwner={view.inputOwner}
          sendFailure={sendFailure}
          startSend={startSend}
          canClaimInput={controllable && attachmentId !== null}
          onClaimInput={() => {
            // Taking input remounts the terminal under the new ownership, which
            // drops the focused button; the keyboard follows to the composer.
            void claimInput().then((claimed) => {
              if (claimed) useHelpPanelStore.getState().requestFocus();
            });
          }}
        />
      )}

      <ConfirmDialog
        isOpen={pendingConfirm !== null}
        title={
          pendingConfirm?.kind === "discard"
            ? "Stop the global assistant?"
            : "Restart the global assistant's conversation?"
        }
        description={
          pendingConfirm?.kind === "discard"
            ? "Its agent stops in every window and the next start opens a new conversation"
            : "Its agent stops in every window and a new conversation starts"
        }
        confirmLabel={
          pendingConfirm?.kind === "discard" ? "Stop global assistant" : "Restart conversation"
        }
        variant="destructive"
        onConfirm={() => {
          const pending = pendingConfirm;
          setPendingConfirm(null);
          if (!pending) return;
          // Acting on the run on screen: whatever replaces it is the one to follow.
          useHelpPanelStore.getState().selectGlobal(null);
          void (pending.kind === "discard"
            ? discard(pending.generation)
            : restart(pending.generation));
        }}
        onClose={() => setPendingConfirm(null)}
      />
    </div>
  );
}

/**
 * The live terminal and this window's composer for one run under one input
 * ownership. Keyed by both, so taking or losing input opens a fresh stream:
 * a send queued through the old one is refused by main, never re-sent here.
 */
function GlobalAssistantTerminal({
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
