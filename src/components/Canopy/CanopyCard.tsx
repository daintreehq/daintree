import { Suspense, lazy, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  CheckCheck,
  KeyRound,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { CLOSE_OWNER_ATTR, CLOSE_REQUEST_EVENT } from "@/lib/closeRequest";
import { Button } from "@/components/ui/button";
import { SURFACE_HEADER_FOCUS_LIFT_CLASS, SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { AgentStateChip } from "@/components/Terminal/TerminalAgentIndicator";
import { getEffectiveStateLabel } from "@/components/Worktree/terminalStateConfig";
import type { BrandMarkSurface } from "@/lib/brandIcon";
import type { HybridInputBarHandle } from "@/components/Terminal/HybridInputBar";
import { isMac } from "@/lib/platform";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import {
  answerNeedsConfirm,
  answerOptions,
  itemArchived,
  itemLooksDone,
  quickApproveOption,
  type CanopyItem,
} from "./canopyModel";
import { KIND_LABEL } from "./CanopyRow";
import { CanopyTerminal, type CanopyStreamState } from "./CanopyTerminal";
import { CanopyTitle } from "./CanopyTitle";

const LazyHybridInputBar = lazy(() =>
  import("@/components/Terminal/HybridInputBar").then((m) => ({ default: m.HybridInputBar }))
);

const WarningGlyph = SEVERITY_GLYPH.warning;

/** A grid pane's header control: a ghost icon button with a 14px glyph. */
const CONTROL_ICON = "[&_svg]:size-3.5";
/** How long a first press of Trash waits for the second before it stands down. */
export const TRASH_CONFIRM_MS = 4_000;

export interface CanopyCardHandlers {
  onOpen: (item: CanopyItem) => void;
  onTrash: (item: CanopyItem) => void;
  /** Archive the run, or bring an archived one back to the inbox. */
  onArchive: (item: CanopyItem) => void;
  /**
   * Something was sent to the run from the pane: a reply from the composer, or
   * Return typed straight into the live terminal.
   */
  onSent: (item: CanopyItem, via: "composer" | "terminal") => void;
  /** Main refused what the composer sent; the draft stays in the composer. */
  onSendFailed: (item: CanopyItem, error: unknown) => void;
  /** Pick one of the options the run's dialog shows, by its label. */
  onAnswer: (item: CanopyItem, label: string) => void;
  /** Rename the run's terminal; settles once main has it, and rejects when refused. */
  onRename: (item: CanopyItem, title: string) => Promise<void>;
  /** Escape in the reply: the keyboard goes back to the run's row in the list. */
  onLeavePane: (item: CanopyItem) => void;
}

/** What the list can ask of the pane for the agent it has selected. */
export interface CanopyCardHandle {
  /** Handle a key aimed at the list's selected row; true when it was used. */
  handleKey: (event: KeyboardEvent<HTMLElement>) => boolean;
  /** Put the keyboard in the reply, when the run takes one; false when it doesn't. */
  focusComposer: () => boolean;
}

/** Where the keyboard lands in the pane when it opens: what the user was in on the agent before. */
export type CanopyPaneFocus = "composer" | "terminal" | null;

interface CanopyCardProps extends CanopyCardHandlers {
  item: CanopyItem;
  domId: string;
  /** The element saying where the agent is — its project and branch. */
  describedBy?: string;
  ref?: React.Ref<CanopyCardHandle>;
  /** Take the keyboard into the composer or the terminal once they are ready. */
  initialFocus?: CanopyPaneFocus;
  /** The handoff above landed, gave up, or gave way to the user. */
  onInitialFocusSettled?: () => void;
  /**
   * Trash asked for from the row's menu: armed as its first press arms it, for
   * the pane's button or ⌘⌫ to confirm. Each new number is a new request.
   */
  armTrash?: number;
  /** A rename asked for from the row (its menu, or F2): each new number is a new request. */
  renameRequest?: number;
}

/**
 * The composer is offered unless a secret is being asked for — by the card's
 * reading or by the live screen itself, which covers a run not read yet. A
 * composer keeps history, and a password must never land in it; a secret is
 * typed straight into the live terminal instead, which keeps nothing.
 */
export function canReplyTo(item: CanopyItem, liveSecretPrompt = false): boolean {
  return !liveSecretPrompt && !(item.card?.secretPrompt === true && !item.stale);
}

/**
 * Trash is always offered: it takes two presses, and the terminal comes back
 * from the trash like any other, so a working agent needs no other gate.
 */
export function canTrashItem(_item: CanopyItem): boolean {
  return true;
}

export function canopyCardDomId(runId: string): string {
  return `canopy-card-${runId}`;
}

function HeaderControl({
  label,
  shortcut,
  onClick,
  armed = false,
  describedBy,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  /**
   * Waiting for a confirming second press: the label is spelled out beside the
   * glyph. The only state that wears red, so a hovered or refocused control
   * never reads as still armed.
   */
  armed?: boolean;
  describedBy?: string;
  children: React.ReactNode;
}) {
  // One button whether armed or not, so keyboard focus stays on it while it
  // changes shape between the two presses.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={armed ? "ghost-danger" : "ghost"}
          size={armed ? "xs" : "icon-xs"}
          aria-label={armed ? undefined : label}
          aria-keyshortcuts={shortcut}
          aria-describedby={describedBy}
          onClick={onClick}
          data-armed={armed || undefined}
          className={cn(CONTROL_ICON, armed && "bg-status-error/10")}
        >
          {children}
          {armed && label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{armed ? "Press again to trash" : label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The selected agent, drawn the way its own pane draws it in the grid: the
 * panel frame, a compact header with the terminal's title and its controls,
 * then the terminal itself — live, on the WebGL renderer — with the real
 * composer flush beneath. Type, press Enter, and it goes to that agent, from
 * whichever project it is in.
 */
export function CanopyCard({
  item,
  domId,
  describedBy,
  ref,
  onOpen,
  onTrash,
  onArchive,
  onSent,
  onSendFailed,
  onAnswer,
  onRename,
  onLeavePane,
  initialFocus = null,
  onInitialFocusSettled,
  armTrash,
  renameRequest,
}: CanopyCardProps) {
  const [stream, setStream] = useState<CanopyStreamState>({
    watchId: null,
    ended: false,
    secretPrompt: false,
  });
  const composerRef = useRef<HybridInputBarHandle>(null);
  // The pane the keyboard is in lifts its title bar, as a focused grid pane does.
  const [focused, setFocused] = useState(false);
  const { row } = item;
  const run = row.run;
  const canReply = canReplyTo(item, stream.secretPrompt);
  const canTrash = canTrashItem(item);
  const archived = itemArchived(item);
  const looksDone = itemLooksDone(item);
  const sectionRef = useRef<HTMLElement>(null);
  const canReplyRef = useRef(canReply);
  useEffect(() => {
    canReplyRef.current = canReply;
  });

  // Moved here with ⌘↑/⌘↓ from inside another agent's composer or terminal:
  // the keyboard lands in the same place on this one. The composer is a lazy
  // chunk and the terminal opens its stream asynchronously, so this waits a few
  // frames for whichever it is to exist.
  // Once per pane: the pane is keyed by run, so a new agent is a new mount.
  const initialFocusRef = useRef(initialFocus);
  const onSettledRef = useRef(onInitialFocusSettled);
  useEffect(() => {
    onSettledRef.current = onInitialFocusSettled;
  });
  useEffect(() => {
    const initialFocus = initialFocusRef.current;
    if (initialFocus === null) return;
    let frame = 0;
    const settle = () => onSettledRef.current?.();
    const attempt = (tries: number) => {
      const section = sectionRef.current;
      if (!section) return;
      // The user put the keyboard somewhere else meanwhile — clicked a row,
      // say: that wins over a handoff still waiting for the pane to be ready.
      // A menu still closing (Reply, picked from a row's menu) is not the
      // user going elsewhere: the handoff waits it out.
      const active = document.activeElement;
      if (
        active !== null &&
        active !== document.body &&
        !section.contains(active) &&
        active.closest('[role="menu"]') === null
      ) {
        settle();
        return;
      }
      const textarea = section.querySelector<HTMLElement>("[data-canopy-terminal] textarea");
      // No composer here (a secret prompt): the terminal takes the keys instead.
      const target = initialFocus === "composer" && canReplyRef.current ? "composer" : "terminal";
      if (target === "composer") {
        // Focused directly and confirmed from the DOM: the composer's own
        // deferred focus defers to the grid's focus preference, which has no
        // say over a handoff the user asked for here.
        composerRef.current?.focus();
        if (section.querySelector(".cm-editor")?.contains(document.activeElement)) {
          settle();
          return;
        }
      } else if (textarea) {
        textarea.focus({ preventScroll: true });
        settle();
        return;
      }
      // The composer is a lazy chunk and the stream opens asynchronously; a
      // cold load can take a while, so this waits up to a few seconds.
      if (tries < 240) frame = requestAnimationFrame(() => attempt(tries + 1));
      else settle();
    };
    frame = requestAnimationFrame(() => attempt(1));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Trash takes two presses — the button or ⌘⌫ — and the trash is the way back,
  // as for any terminal. The first press arms it for a few seconds, for the screen
  // that was showing: a respawn, a new screen or a change of state in between
  // means the second press is a first press again.
  // A screen that moved (its card flagged as from an earlier read) is a new
  // target before its new reading lands.
  const trashTarget = `${run.runId}:${run.spawnedAt}:${item.card?.revision ?? ""}:${item.kind}:${item.card?.priorityFromEarlierRead === true}`;
  const [trashPressedFor, setTrashPressedFor] = useState<string | null>(null);
  const trashArmed = canTrash && trashPressedFor === trashTarget;
  // A press is for the target it was made on: once that changes — another
  // agent selected, or this one moved on — it stands down, and a return to it
  // before the timeout must not re-arm the button by itself.
  useEffect(() => {
    setTrashPressedFor((pressed) => (pressed === null || pressed === trashTarget ? pressed : null));
  }, [trashTarget]);
  useEffect(() => {
    if (trashPressedFor === null) return;
    const timer = setTimeout(() => setTrashPressedFor(null), TRASH_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [trashPressedFor]);
  const armedRequestRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (armTrash === undefined || armTrash === armedRequestRef.current) return;
    armedRequestRef.current = armTrash;
    if (canTrash) setTrashPressedFor(trashTarget);
  }, [armTrash, canTrash, trashTarget]);
  // A number on a risky action takes two presses, as Trash does: the first
  // says which choice it would pick, the second picks it. For the screen it was
  // pressed on only — a new screen or a change of state stands it down.
  const [answerArmed, setAnswerArmed] = useState<{
    label: string;
    digit: number;
    target: string;
  } | null>(null);
  // Armed only while that choice is still on offer at that number: options
  // that change or go away under the same screen stand it down too.
  const armedAnswer =
    answerArmed?.target === trashTarget &&
    answerOptions(item)[answerArmed.digit - 1] === answerArmed.label
      ? answerArmed
      : null;
  useEffect(() => {
    setAnswerArmed((armed) => (armed === null || armed.target === trashTarget ? armed : null));
  }, [trashTarget]);
  useEffect(() => {
    if (answerArmed === null) return;
    const timer = setTimeout(() => setAnswerArmed(null), TRASH_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [answerArmed]);

  const pressTrash = () => {
    if (!trashArmed) {
      setTrashPressedFor(trashTarget);
      return;
    }
    setTrashPressedFor(null);
    onTrash(item);
  };

  // Cmd+W with the keyboard in this pane — its terminal, its reply or its
  // title bar — closes the agent's terminal to the trash, as Cmd+W on its grid
  // pane would; the trash keeps it running a while, and the toast takes it
  // back. From the list, Cmd+W closes the panel instead.
  const onTrashRef = useRef(onTrash);
  const itemRef = useRef(item);
  useEffect(() => {
    onTrashRef.current = onTrash;
    itemRef.current = item;
  });
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const onClose = (event: Event) => {
      event.preventDefault();
      onTrashRef.current(itemRef.current);
    };
    section.addEventListener(CLOSE_REQUEST_EVENT, onClose);
    return () => section.removeEventListener(CLOSE_REQUEST_EVENT, onClose);
  }, []);

  const handleKey = (event: KeyboardEvent<HTMLElement>): boolean => {
    // One key answers the dialog: its number picks that option, Y the first
    // (never on a risky action, which takes its number).
    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      const options = answerOptions(item);
      const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : null;
      const label =
        digit !== null
          ? (options[digit - 1] ?? null)
          : event.key === "y" || event.key === "Y"
            ? quickApproveOption(item)
            : null;
      if (label !== null) {
        event.preventDefault();
        if (event.repeat) return true;
        const confirms = armedAnswer?.digit === digit && armedAnswer.label === label;
        if (digit !== null && answerNeedsConfirm(item) && !confirms) {
          setAnswerArmed({ label, digit, target: trashTarget });
          return true;
        }
        setAnswerArmed(null);
        onAnswer(item, label);
        return true;
      }
    }
    if ((event.key === "r" || event.key === "R") && canReply && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      composerRef.current?.focus();
      return true;
    }
    if (
      (event.key === "e" || event.key === "E") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      if (!event.repeat) onArchive(item);
      return true;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey) && canTrash) {
      event.preventDefault();
      // A held chord is one press, not the confirming second one.
      if (!event.repeat) pressTrash();
      return true;
    }
    return false;
  };
  // Asked for from the row's menu, the handoff waits for the menu to close —
  // its focus trap would take the keyboard straight back — and is confirmed
  // from the DOM, trying again for a few frames until it lands.
  const focusFrameRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(focusFrameRef.current), []);
  const focusComposer = (): boolean => {
    if (!canReply) return false;
    cancelAnimationFrame(focusFrameRef.current);
    // The composer is a lazy chunk: on a cold pane it may not exist yet, so
    // the handoff keeps trying while it loads, as the pane's own does — until
    // the user puts the keyboard somewhere themselves, which then stands.
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
    };
    const stopListening = () => {
      window.removeEventListener("pointerdown", interrupt, true);
      window.removeEventListener("keydown", interrupt, true);
    };
    // Registered after this frame, so the press that chose Reply isn't one.
    requestAnimationFrame(() => {
      if (interrupted) return;
      window.addEventListener("pointerdown", interrupt, true);
      window.addEventListener("keydown", interrupt, true);
    });
    const attempt = (tries: number) => {
      if (interrupted || !canReplyRef.current) {
        stopListening();
        return;
      }
      composerRef.current?.focus();
      const landed = sectionRef.current
        ?.querySelector(".cm-editor")
        ?.contains(document.activeElement);
      if (!landed && tries < 240) {
        focusFrameRef.current = requestAnimationFrame(() => attempt(tries + 1));
      } else {
        stopListening();
      }
    };
    focusFrameRef.current = requestAnimationFrame(() => attempt(1));
    return true;
  };
  useImperativeHandle(ref, () => ({ handleKey, focusComposer }));

  const agentId = isBuiltInAgentId(run.agentId) ? run.agentId : undefined;
  // The grid's chip rules: nothing while idle, and a settled agent keeps its
  // glyph only to explain a session cost, which the panel does not have.
  const agentState = run.agentState;
  const showState =
    agentState !== undefined &&
    agentState !== "idle" &&
    agentState !== "completed" &&
    agentState !== "exited";
  const brandSurface: BrandMarkSurface = focused
    ? { surface: "surface-panel", extension: "panel-header-focus-bg", lift: "overlay-medium" }
    : { surface: "surface-panel", extension: "panel-header-bg" };

  // Through the open stream only, so main sends to the incarnation on screen
  // or to nothing.
  // The draft clears only once main has taken the text: a refused send (the
  // agent exited, the terminal respawned) leaves the reply where it was typed.
  const submit = async (text: string, imagePaths?: readonly string[]): Promise<boolean> => {
    const watchId = stream.watchId;
    if (watchId === null) return false;
    try {
      await window.electron.canopy.terminalSubmit(
        watchId,
        text,
        imagePaths && imagePaths.length > 0 ? [...imagePaths] : undefined
      );
    } catch (error) {
      onSendFailed(item, error);
      return false;
    }
    onSent(item, "composer");
    return true;
  };

  return (
    <section
      ref={sectionRef}
      id={domId}
      aria-label={`${row.title}, ${KIND_LABEL[item.kind]}`}
      aria-describedby={describedBy}
      data-canopy-detail=""
      {...{ [CLOSE_OWNER_ATTR]: "" }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocused(false);
      }}
      className="group/panel flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-overlay bg-surface shadow-[var(--theme-shadow-ambient)] transition-colors duration-150 hover:border-tint/[0.08]"
    >
      <SurfaceHeader
        density="compact"
        brandSurface={brandSurface}
        className={cn(
          "relative overflow-hidden text-xs transition-colors select-none",
          focused ? SURFACE_HEADER_FOCUS_LIFT_CLASS : "bg-[var(--panel-header-bg,transparent)]"
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 self-stretch">
          <span
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-text-primary"
            data-brand-active={focused || undefined}
          >
            <TerminalIcon
              chrome={row.chrome}
              className="h-3.5 w-3.5"
              brandColor={row.presetColor ?? row.chrome.color}
            />
          </span>
          <CanopyTitle
            title={row.title}
            onRename={(title) => onRename(item, title)}
            renameRequest={renameRequest}
          />
          {/* The readers think it is finished and Daintree sees it stopped:
              said in the title bar rather than over the terminal — where it
              would hide the agent's own report, or resize the agent if it took
              rows of its own. */}
          {armedAnswer !== null && (
            <span
              role="status"
              data-canopy-answer-armed=""
              className="flex min-w-0 shrink items-center gap-1 text-text-primary"
            >
              <WarningGlyph className="size-3.5 shrink-0 text-status-warning" aria-hidden="true" />
              <span className="truncate">
                Press {armedAnswer.digit} again: {armedAnswer.label}
              </span>
            </span>
          )}
          {looksDone && (
            <span
              role="status"
              data-canopy-looks-done=""
              className="flex shrink-0 items-center gap-1 text-text-secondary"
            >
              <CheckCheck className="size-3.5 shrink-0" aria-hidden="true" />
              Looks done
            </span>
          )}
        </div>
        <div
          role="toolbar"
          aria-label="Terminal"
          className="ml-1.5 flex shrink-0 items-center gap-1"
        >
          <HeaderControl
            label={archived ? "Move to inbox" : "Archive"}
            shortcut="E"
            onClick={() => onArchive(item)}
          >
            {archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
          </HeaderControl>
          {canTrash && (
            <HeaderControl
              label="Trash terminal"
              shortcut={isMac() ? "Meta+Backspace" : "Control+Backspace"}
              onClick={pressTrash}
              armed={trashArmed}
              describedBy={trashArmed ? `${domId}-trash-confirm` : undefined}
            >
              <Trash2 aria-hidden="true" />
            </HeaderControl>
          )}
          <span id={`${domId}-trash-confirm`} role="status" className="sr-only">
            {trashArmed ? "Press Trash terminal again to trash it" : ""}
          </span>
          <HeaderControl label="Go to terminal" onClick={() => onOpen(item)}>
            <SquareArrowOutUpRight aria-hidden="true" />
          </HeaderControl>
        </div>
        {/* The agent's state chip, in the reserved box at the far right where every agent pane keeps it. */}
        {agentId !== undefined && (
          <span className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center">
            {showState && (
              <AgentStateChip
                agentState={agentState}
                ariaLabel={`Agent state: ${getEffectiveStateLabel(agentState)}`}
              />
            )}
          </span>
        )}
      </SurfaceHeader>

      <div
        className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface-canvas"
        // Escape belongs to the agent here — it interrupts or backs out of a
        // menu — so it must not also close the dialog around it.
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // A reply hands Escape to the list through `onSendKey`; one that is
            // disabled (its terminal gone) never handles the key at all, so a
            // reply that left it unhandled goes back to the list from here.
            // Not mid-composition: there Escape is the input method's.
            if (
              !event.defaultPrevented &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229 &&
              event.target instanceof Element &&
              event.target.closest(".cm-editor") !== null
            ) {
              onLeavePane(item);
            }
            event.stopPropagation();
            event.preventDefault();
          }
        }}
      >
        <CanopyTerminal
          key={`${item.runId}:${run.spawnedAt}`}
          runId={item.runId}
          spawnedAt={run.spawnedAt}
          onStreamChange={setStream}
          onSubmitted={() => onSent(item, "terminal")}
          onGoTo={() => onOpen(item)}
        />
        {canReply ? (
          <div data-keybindings-isolated="" className="contents">
            <Suspense fallback={null}>
              <LazyHybridInputBar
                ref={composerRef}
                isolated
                terminalId={item.runId}
                cwd={run.cwd ?? ""}
                agentId={agentId}
                agentState={run.agentState}
                disabled={stream.watchId === null}
                onSend={({ text, imagePaths }) => void submit(text, imagePaths)}
                submitText={submit}
                onSendKey={(key) => {
                  // Escape in a dialog means leave: here it goes back to the
                  // list rather than to the agent, where it would interrupt a
                  // working turn. The terminal above still takes it.
                  if (key === "escape") {
                    onLeavePane(item);
                    return;
                  }
                  const watchId = stream.watchId;
                  if (watchId === null) return;
                  window.electron.canopy.terminalSendKey(watchId, key).then(
                    // Only Enter answers anything; arrows and Escape steer the
                    // agent's own menu and must not move the panel on.
                    () => {
                      if (key === "enter") onSent(item, "composer");
                    },
                    (error: unknown) => onSendFailed(item, error)
                  );
                }}
              />
            </Suspense>
          </div>
        ) : (
          <p className="flex shrink-0 items-center gap-1.5 px-3.5 py-3 text-xs text-text-secondary">
            <KeyRound className="size-3.5 shrink-0" aria-hidden="true" />
            It's asking for a secret: type it straight into the terminal above
          </p>
        )}
      </div>
    </section>
  );
}
