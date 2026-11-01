import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  Bell,
  Clock,
  KeyRound,
  MessageSquare,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { CLOSE_OWNER_ATTR, CLOSE_REQUEST_EVENT } from "@/lib/closeRequest";
import { Button } from "@/components/ui/button";
import { Kbd, KbdChord } from "@/components/ui/Kbd";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { SURFACE_HEADER_FOCUS_LIFT_CLASS, SurfaceHeader } from "@/components/ui/SurfaceHeader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CirclePause } from "@/components/icons";
import {
  AGENT_SNOOZE_DURATION_OPTIONS,
  AGENT_SNOOZE_LABEL,
} from "@shared/utils/agentSnoozeDurations";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { AgentStateChip } from "@/components/Terminal/TerminalAgentIndicator";
import { SESSION_LABELS } from "@/components/Worktree/terminalStateConfig";
import { resolvePaneSessionPresentation } from "@/lib/paneSessionPresentation";
import { usePaneObservation } from "@/hooks/useRunSessionPresentation";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import type { BrandMarkSurface } from "@/lib/brandIcon";
import type { HybridInputBarHandle } from "@/components/Terminal/HybridInputBar";
import { isMac } from "@/lib/platform";
import { PRESS_AGAIN_CONFIRM_MS } from "@/lib/pressAgain";
import { isNewWindowClick } from "@/components/Hosts/hostSwitching";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import {
  answerNeedsConfirm,
  answerOptions,
  itemArchived,
  itemLooksDone,
  quickApproveOption,
  type CanopyItem,
} from "./canopyModel";
import { KIND_LABEL, itemDetail, readerAttribution } from "./CanopyRow";
import { CanopyTerminal, type CanopyStreamState } from "./CanopyTerminal";
import { CanopyTitle } from "./CanopyTitle";
import type { CanopyAsideActions } from "./CanopyRowMenu";
import { ownCanopyTerminalApi, type CanopyTerminalApi } from "./canopyHostSource";
import { parseAllHostsKey } from "./canopyAllHosts";
import {
  DICTATION_OWNER_ATTR,
  canopyReplyVoiceId,
  type CanopyReplyDictation,
} from "@/services/canopyReplyDictation";
import {
  selectMicNoticeForPanel,
  useVoiceRecordingStore,
  type VoiceRecordingTarget,
} from "@/store/voiceRecordingStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { VoiceMicNoticeBanner } from "@/components/Terminal/VoiceMicNoticeBanner";

const LazyHybridInputBar = lazy(() =>
  import("@/components/Terminal/HybridInputBar").then((m) => ({ default: m.HybridInputBar }))
);

const WarningGlyph = SEVERITY_GLYPH.warning;

/** A grid pane's header control: a ghost icon button with a 14px glyph. */
const CONTROL_ICON = "[&_svg]:size-3.5";
/** How long a first press of Trash waits for the second before it stands down. */
export const TRASH_CONFIRM_MS = PRESS_AGAIN_CONFIRM_MS;

export interface CanopyCardHandlers {
  /** `newWindow`: Cmd/Ctrl held, so another host's run opens in a new window. */
  onOpen: (item: CanopyItem, newWindow?: boolean) => void;
  onTrash: (item: CanopyItem) => void;
  /** Archive the run, or bring an archived one back to the inbox. */
  onArchive: (item: CanopyItem) => void;
  /**
   * Something was sent to the run from the pane: a reply from the composer, or
   * Return typed straight into the live terminal. `moveOnTo`: sent with ⌘↩,
   * the run the reply named as it was pressed.
   */
  onSent: (item: CanopyItem, moveOnTo?: string) => void;
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
  /**
   * Put the keyboard in the reply — or, while a secret is asked for and
   * there is no reply, in the live terminal. Always lands somewhere in the pane.
   */
  focusComposer: () => boolean;
  /** Where the dictation key dictates for this agent: its reply, or why not. */
  dictation: () => CanopyReplyDictation;
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
   * The recording indicator sent the keyboard back to this reply, which a
   * dictation is writing into (#14778): each new number is a new request,
   * whether the pane opens for it or is already showing.
   */
  dictationRequest?: number;
  /** That handoff landed, gave up, or gave way to the user. */
  onDictationSettled?: (request: number) => void;
  /**
   * Trash asked for from the row's menu: armed as its first press arms it, for
   * the pane's button or ⌘⌫ to confirm. Each new number is a new request.
   */
  armTrash?: number;
  /** A rename asked for from the row (its menu, or F2): each new number is a new request. */
  renameRequest?: number;
  /**
   * The run is on a host other than the window's, picked in the panel: the
   * id of that host. Its terminal, reply and answers reach it there; going to
   * it, renaming and trashing don't, and nothing of this machine's files is
   * offered to it.
   */
  otherHostId?: string;
  /** The host the panel lists the run under: null for the window's own, else that host or All hosts. */
  hostScope?: string | null;
  /** Park and snooze for a run on the window's own host; absent where they can't be offered. */
  aside?: CanopyAsideActions;
  /** The run's host's Canopy; the window's own by default. */
  terminalApi?: CanopyTerminalApi;
  /** The link to the run's host is down: nothing is typed or answered until it is back. */
  reconnecting?: boolean;
  /** Which assistant started it or holds it, from main's own records; null when none is known. */
  workLabel?: string | null;
  /** Where ⌘↩ from the reply goes on to once it sends, named in the reply; null for nowhere. */
  moveOnTo?: CanopyItem | null;
  /** The reader is on, so a reading may land while the card is open. */
  reading?: boolean;
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
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
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
  dictationRequest,
  onDictationSettled,
  armTrash,
  renameRequest,
  otherHostId,
  hostScope = null,
  aside,
  terminalApi = ownCanopyTerminalApi,
  reconnecting = false,
  workLabel = null,
  moveOnTo = null,
  reading = false,
}: CanopyCardProps) {
  const otherHost = otherHostId !== undefined;
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
  const answerChoices = answerOptions(item);
  const canTrash = canTrashItem(item);
  const canSetAside = aside?.canSetAside(item) ?? false;
  const archived = itemArchived(item);
  const looksDone = itemLooksDone(item);
  const sectionRef = useRef<HTMLElement>(null);
  const canReplyRef = useRef(canReply);
  useEffect(() => {
    canReplyRef.current = canReply;
  });
  // The reply goes away under the user's typing when a secret is asked for:
  // the keyboard goes to the terminal, where the secret is typed — not to
  // nowhere, and from there to the list, where every letter is a command.
  // Whether the reply held it is read as it unmounts, before its editor leaves.
  const replyHadFocusRef = useRef(false);
  const replyHostRef = useCallback((node: HTMLDivElement | null) => {
    if (node === null) return;
    replyHadFocusRef.current = false;
    return () => {
      replyHadFocusRef.current = node.contains(document.activeElement);
    };
  }, []);
  useLayoutEffect(() => {
    if (canReply || !replyHadFocusRef.current) return;
    replyHadFocusRef.current = false;
    sectionRef.current
      ?.querySelector<HTMLElement>("[data-canopy-terminal] textarea")
      ?.focus({ preventScroll: true });
  }, [canReply]);

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
  // pane would; the trash keeps it a while, and the toast and Z take it back.
  // From the list, with no pane in hand, Cmd+W closes Canopy instead.
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

  // The one path an answer takes, from a number key, Y or a click on a choice:
  // nothing is pressed into a screen this panel can't see, and a risky action
  // takes two presses of the same choice.
  const pressAnswer = (label: string, digit: number | null) => {
    if (reconnecting) return;
    const confirms = digit !== null && armedAnswer?.digit === digit && armedAnswer.label === label;
    if (digit !== null && answerNeedsConfirm(item) && !confirms) {
      setAnswerArmed({ label, digit, target: trashTarget });
      return;
    }
    setAnswerArmed(null);
    onAnswer(item, label);
  };

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
        if (!event.repeat) pressAnswer(label, digit);
        return true;
      }
    }
    if (
      (event.key === "r" || event.key === "R") &&
      canReply &&
      stream.watchId !== null &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
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
  // One handoff at a time, and every way it ends — landed, given up, the user
  // going elsewhere, another Reply, the pane unmounting — stops its frames
  // and its listeners together.
  const stopHandoffRef = useRef<() => void>(() => {});
  useEffect(() => () => stopHandoffRef.current(), []);
  const focusComposer = (forDictation = false, onDone?: () => void): boolean => {
    stopHandoffRef.current();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onDone?.();
    };
    // No reply here (a secret is being asked for, perhaps before the card
    // knows it): the keyboard goes to the live terminal, where it is typed,
    // once the menu that asked has closed.
    if (!canReply) {
      const frame = requestAnimationFrame(() => {
        sectionRef.current
          ?.querySelector<HTMLElement>("[data-canopy-terminal] textarea")
          ?.focus({ preventScroll: true });
        finish();
      });
      stopHandoffRef.current = () => {
        cancelAnimationFrame(frame);
        finish();
      };
      return true;
    }
    // The composer is a lazy chunk: on a cold pane it may not exist yet, so
    // the handoff keeps trying while it loads, as the pane's own does — until
    // the user puts the keyboard somewhere themselves, which then stands.
    let frame = 0;
    let listenFrame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(listenFrame);
      window.removeEventListener("pointerdown", stop, true);
      window.removeEventListener("keydown", onKey, true);
      finish();
    };
    stopHandoffRef.current = stop;
    // Listened for after this frame, so the press that chose Reply isn't one,
    // nor the auto-repeat of a key still held from it (the dictation key, held to talk).
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.repeat) stop();
    };
    listenFrame = requestAnimationFrame(() => {
      window.addEventListener("pointerdown", stop, true);
      window.addEventListener("keydown", onKey, true);
    });
    const attempt = (tries: number) => {
      if (!canReplyRef.current) return stop();
      if (forDictation) composerRef.current?.focusForDictation();
      else composerRef.current?.focus();
      const landed = sectionRef.current
        ?.querySelector(".cm-editor")
        ?.contains(document.activeElement);
      if (landed || tries >= 240) return stop();
      frame = requestAnimationFrame(() => attempt(tries + 1));
    };
    frame = requestAnimationFrame(() => attempt(1));
    return true;
  };
  // Its own dictation, apart from the grid pane's composer on the same terminal.
  // Main reads keyterms, vocabulary and file links from the terminal only when
  // this view's project owns it: another project's or host's gives it none.
  const ownsContext = otherHostId === undefined && run.workspaceId === getViewWorkspaceId();
  const voiceTarget: VoiceRecordingTarget = {
    panelId: canopyReplyVoiceId(item.runId, otherHostId),
    panelTitle: `Reply to ${row.title}`,
    surface: "canopy-reply",
    ...(otherHostId !== undefined ? { otherHostId } : {}),
    ...(ownsContext ? { terminalId: item.runId } : {}),
    canopyRow: { runId: item.runId, hostScope },
  };
  const voiceMicNotice = useVoiceRecordingStore((s) =>
    selectMicNoticeForPanel(s, voiceTarget.panelId)
  );
  const dictation = (): CanopyReplyDictation => {
    if (!canReply) {
      return {
        ok: false,
        message: "It's asking for a secret. Type it straight into the terminal above.",
      };
    }
    if (reconnecting) {
      return {
        ok: false,
        message: "Its host is reconnecting. Try dictation again once it's back.",
      };
    }
    if (stream.watchId === null) {
      return {
        ok: false,
        message: stream.ended
          ? "Its terminal has ended, so there's nothing to reply to."
          : "Its terminal is still connecting. Try dictation again in a moment.",
      };
    }
    return {
      ok: true,
      target: voiceTarget,
      focus: () => {
        // Already in the reply, expanded or not: there is nothing to hand over.
        const active = document.activeElement;
        if (active?.closest(".cm-editor") && active.closest(`[${DICTATION_OWNER_ATTR}]`)) return;
        // The words go in at the caret the reply showed, not wherever a fresh
        // editor's focus would put it.
        focusComposer(true);
      },
    };
  };
  useImperativeHandle(ref, () => ({ handleKey, focusComposer: () => focusComposer(), dictation }));

  // Sent back here by the recording indicator: the keyboard goes to the
  // reply, from the indicator or wherever the opening panel put it, and stays
  // with the user once they press anything themselves.
  const focusComposerRef = useRef(focusComposer);
  const onDictationSettledRef = useRef(onDictationSettled);
  useEffect(() => {
    focusComposerRef.current = focusComposer;
    onDictationSettledRef.current = onDictationSettled;
  });
  useEffect(() => {
    if (dictationRequest === undefined) return;
    focusComposerRef.current(true, () => onDictationSettledRef.current?.(dictationRequest));
  }, [dictationRequest]);

  const agentId = isBuiltInAgentId(run.agentId) ? run.agentId : undefined;
  // The grid pane's own glyph: its display state through the run's fleet band.
  // Amber is an unread Canopy ask, a hand-back is unread or finished, and a
  // prompt that asks nothing draws nothing. The pane's newer observation
  // speaks for the run when this view holds it, as on the pane, and the row's
  // otherwise: another project's or host's terminal id names no pane here.
  // Display state and observation come from the same one, so a pane already
  // back at work draws its spinner rather than a wait the row still holds.
  const ownPane = usePaneObservation(ownsContext ? item.runId : null);
  const observed = ownPane ?? run;
  const agentState = resolvePaneSessionPresentation(
    getTerminalAgentDisplayState(row.chrome, observed.agentState),
    row.band,
    observed
  );
  const { detail, action, progress, facts, contextWarning, readerWritten } = itemDetail(item);
  // An open question is the pane's anchor, whole and in the screen's words: the
  // row could only fit a headline, and a summary of it would only say it again.
  const question =
    item.kind === "question" && !item.stale && item.card?.question ? item.card.question : null;
  const shownDetail = question !== null && readerWritten ? null : detail;
  // The readers' verdict that it is finished is theirs too, so it sits with
  // their other words, under the same attribution, rather than in the title bar
  // where it would read as Daintree's own state.
  const readerSaid = readerWritten || question !== null || looksDone;
  const detailAttribution = readerSaid ? readerAttribution(item, Date.now()) : null;
  const summaryNotes = [
    workLabel,
    contextWarning,
    ...facts.map((fact, index) => {
      const said = fact.charAt(0).toLowerCase() + fact.slice(1);
      return index === 0 ? `Reported: ${said}` : said;
    }),
  ].filter((note): note is string => note !== null && note !== "");
  const hasSummary =
    looksDone ||
    question !== null ||
    shownDetail !== null ||
    action !== null ||
    progress !== null ||
    summaryNotes.length > 0;
  const brandSurface: BrandMarkSurface = focused
    ? { surface: "surface-panel", extension: "panel-header-focus-bg", lift: "overlay-medium" }
    : { surface: "surface-panel", extension: "panel-header-bg" };

  // A dictated reply can go after its card has: the send waits for its
  // cleanup, and the user may have moved to another run meanwhile (#15510).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Through the open stream, so main sends to the incarnation on screen or to
  // nothing. A reply that outlived its card goes by the run the card showed,
  // held to the same incarnation: its stream ended with the card.
  // The draft clears only once main has taken the text: a refused send (the
  // agent exited, the terminal respawned) leaves the reply where it was typed.
  const submit = async (
    text: string,
    imagePaths?: readonly string[],
    moveOnTo?: string
  ): Promise<boolean> => {
    const watchId = stream.watchId;
    if (watchId === null && mountedRef.current) return false;
    const images = imagePaths && imagePaths.length > 0 ? [...imagePaths] : undefined;
    try {
      if (mountedRef.current && watchId !== null) {
        await terminalApi.terminalSubmit(watchId, text, images);
      } else {
        await terminalApi.submitReply(item.runId, { spawnedAt: run.spawnedAt }, text, images);
      }
    } catch (error) {
      onSendFailed(item, error);
      return false;
    }
    onSent(item, moveOnTo);
    return true;
  };
  const sendKey = (key: string, moveOnTo?: string) => {
    // Escape in a dialog means leave: here it goes back to the list rather
    // than to the agent, where it would interrupt a working turn. The
    // terminal above still takes it.
    if (key === "escape") {
      onLeavePane(item);
      return;
    }
    const watchId = stream.watchId;
    if (watchId === null) return;
    terminalApi.terminalSendKey(watchId, key).then(
      // Only Enter answers anything; arrows and Escape steer the agent's own
      // menu and are not a reply.
      () => {
        if (key === "enter") onSent(item, moveOnTo);
      },
      (error: unknown) => onSendFailed(item, error)
    );
  };
  // ⌘↩ sends as Enter does, then moves on to the run the reply names at the
  // press, wherever the list has gone by the time the send lands. A dictated
  // send lands after a wait: it goes through the stream open then.
  const sendRef = useRef({ submit, sendKey });
  useEffect(() => {
    sendRef.current = { submit, sendKey };
  });
  const routeModEnter = () => {
    const to = moveOnTo?.runId;
    return {
      submitText: (text: string, imagePaths: readonly string[]) =>
        sendRef.current.submit(text, imagePaths, to),
      sendEnter: () => sendRef.current.sendKey("enter", to),
    };
  };

  return (
    <section
      ref={sectionRef}
      id={domId}
      aria-label={`${row.title}, ${KIND_LABEL[item.kind]}`}
      aria-describedby={describedBy}
      data-canopy-detail=""
      {...{ [CLOSE_OWNER_ATTR]: "", [DICTATION_OWNER_ATTR]: "" }}
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
          {aside !== undefined && canSetAside && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Park or snooze"
                      className={CONTROL_ICON}
                    >
                      <CirclePause aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">Park or snooze</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => aside.onPark(item)}>
                  <CirclePause className="size-3.5" aria-hidden="true" />
                  Park…
                </DropdownMenuItem>
                {run.park !== undefined && (
                  <DropdownMenuItem onSelect={() => aside.onUnpark(item)}>
                    <Bell className="size-3.5" aria-hidden="true" />
                    Unpark
                  </DropdownMenuItem>
                )}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Clock className="size-3.5" aria-hidden="true" />
                    Snooze…
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {AGENT_SNOOZE_DURATION_OPTIONS.map((option) => (
                      <DropdownMenuItem key={option} onSelect={() => aside.onSnooze(item, option)}>
                        {AGENT_SNOOZE_LABEL[option]}
                      </DropdownMenuItem>
                    ))}
                    {run.snooze !== undefined && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => aside.onWake(item)}>
                          Wake now
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
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
          <HeaderControl
            label="Go to terminal"
            onClick={(event) => onOpen(item, isNewWindowClick(event))}
          >
            <SquareArrowOutUpRight aria-hidden="true" />
          </HeaderControl>
        </div>
        {/* The agent's state chip, in the reserved box at the far right where every agent pane keeps it. */}
        {agentId !== undefined && (
          <span className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center">
            {agentState !== undefined && (
              <AgentStateChip
                agentState={agentState}
                ariaLabel={`Agent state: ${SESSION_LABELS[agentState]}`}
              />
            )}
          </span>
        )}
      </SurfaceHeader>

      {/* What the row leaves out to stay three lines tall: the summary, how
          far through its task the run is, and what the agent reported. One
          line, so the terminal keeps the height: what the reader said reads
          from the left, and whose words they are and how old sits at the
          right. Truncated words are whole on hover, and on the screen below.
          Held while the reader is on, so a reading landing never resizes the
          agent, which redraws its scrollback on every resize. */}
      {(hasSummary || reading) && (
        <div
          data-canopy-summary=""
          className="flex h-7 shrink-0 items-center gap-3 border-b border-overlay px-3 text-xs leading-4 text-text-secondary"
        >
          {progress !== null && (
            <span className="flex shrink-0 items-center gap-2 tabular-nums">
              <ProgressBar value={progress.value} label={progress.spoken} className="w-16" />
              <span>{progress.label}</span>
            </span>
          )}
          {action !== null && (
            <TruncatedTooltip content={action}>
              <span className="max-w-[50%] min-w-0 shrink truncate font-mono text-text-primary">
                {/^[\w./-]+$/.test(action) && /[./]/.test(action) ? action : `$ ${action}`}
              </span>
            </TruncatedTooltip>
          )}
          {looksDone && (
            <span
              role="status"
              data-canopy-looks-done=""
              className="shrink-0 whitespace-nowrap text-text-primary"
            >
              Looks done
            </span>
          )}
          {(question ?? shownDetail) !== null && (
            <TruncatedTooltip content={question ?? shownDetail}>
              <span
                className={cn(
                  // What the reader said keeps a share of the line: the notes
                  // beside it give way first.
                  "min-w-[30%] flex-1 truncate",
                  question !== null && "text-text-primary"
                )}
              >
                {question ?? shownDetail}
              </span>
            </TruncatedTooltip>
          )}
          {(summaryNotes.length > 0 || detailAttribution !== null) && (
            <span className="ml-auto flex max-w-[45%] min-w-0 items-center">
              {summaryNotes.length > 0 && (
                <TruncatedTooltip content={summaryNotes.join(" · ")}>
                  <span className="min-w-0 truncate">{summaryNotes.join(" · ")}</span>
                </TruncatedTooltip>
              )}
              {summaryNotes.length > 0 && detailAttribution !== null && (
                <span aria-hidden="true" className="shrink-0 px-1">
                  ·
                </span>
              )}
              {/* Last, so it is read as covering everything before it. */}
              {detailAttribution !== null && (
                <span data-canopy-attribution="" className="shrink-0 whitespace-nowrap">
                  {detailAttribution}
                </span>
              )}
            </span>
          )}
        </div>
      )}

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
          api={terminalApi}
          cwd={run.cwd}
          // The All hosts list names a workspace by its host too.
          projectId={parseAllHostsKey(run.workspaceId)?.id ?? run.workspaceId}
          reconnecting={reconnecting}
          onStreamChange={setStream}
          onSubmitted={() => onSent(item)}
          onGoTo={(event) => onOpen(item, isNewWindowClick(event))}
        />
        {/* Always one line, choices or none, so an ask arriving or answered
            never moves the terminal's foot: choices shrink and truncate rather
            than wrap. */}
        <div
          role="group"
          aria-label="Answer"
          data-canopy-choices=""
          className="flex h-10 shrink-0 items-center gap-1.5 overflow-hidden border-t border-overlay px-3"
        >
          {answerChoices.map((choice, index) => {
            const armed = armedAnswer?.digit === index + 1;
            return (
              <Button
                key={`${index}:${choice}`}
                variant={armed ? "ghost-danger" : "subtle"}
                size="xs"
                disabled={reconnecting}
                data-canopy-choice=""
                data-armed={armed || undefined}
                aria-keyshortcuts={String(index + 1)}
                className={cn("min-w-0 shrink", armed && "bg-status-error/10")}
                onClick={() => pressAnswer(choice, index + 1)}
              >
                <Kbd className="shrink-0">{index + 1}</Kbd>
                <span className="min-w-0 truncate">
                  {armed ? `Press again: ${choice}` : choice}
                </span>
              </Button>
            );
          })}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1.5">
            {canReply && (
              <Button
                variant="ghost"
                size="xs"
                aria-keyshortcuts="R"
                // As the composer it focuses is: shut while the stream is.
                disabled={stream.watchId === null}
                onClick={() => composerRef.current?.focus()}
              >
                <MessageSquare aria-hidden="true" />
                Reply
                <Kbd className="shrink-0">R</Kbd>
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              aria-keyshortcuts="Enter"
              onClick={(event) => onOpen(item, isNewWindowClick(event))}
            >
              <SquareArrowOutUpRight aria-hidden="true" />
              Go to terminal
              <Kbd className="shrink-0">↵</Kbd>
            </Button>
          </span>
        </div>
        {canReply && voiceMicNotice && <VoiceMicNoticeBanner notice={voiceMicNotice} />}
        {canReply ? (
          <div key="reply" ref={replyHostRef} data-keybindings-isolated="" className="contents">
            <Suspense fallback={null}>
              <LazyHybridInputBar
                ref={composerRef}
                isolated
                otherHostId={otherHostId}
                voiceTarget={voiceTarget}
                terminalId={item.runId}
                cwd={otherHost ? "" : (run.cwd ?? "")}
                agentId={agentId}
                agentState={run.agentState}
                disabled={stream.watchId === null}
                onSend={({ text, imagePaths }) => void submit(text, imagePaths)}
                submitText={submit}
                onSendKey={sendKey}
                modEnterSend={routeModEnter}
              />
            </Suspense>
            {/* Held whenever the reply is, named or blank, so a target coming
                and going never resizes the terminal above. */}
            <p
              data-canopy-move-on=""
              className="flex h-6 shrink-0 items-center gap-1.5 px-3.5 pb-1.5 text-xs text-text-secondary"
            >
              {/* Only while the reply can send: a closed stream leaves it disabled. */}
              {moveOnTo !== null && stream.watchId !== null && (
                <>
                  <KbdChord shortcut="Cmd+Enter" density="compact" />
                  <span className="shrink-0">Send and go to</span>
                  <TruncatedTooltip content={moveOnTo.row.title}>
                    <span className="min-w-0 truncate text-text-primary">{moveOnTo.row.title}</span>
                  </TruncatedTooltip>
                </>
              )}
            </p>
          </div>
        ) : (
          // Keyed apart from the reply's host, so the reply unmounts whole and
          // its ref still sees whether its editor held the keyboard.
          <div key="secret" className="flex shrink-0 flex-col">
            {/* The composer's footprint and the line under it, so a reading that
                finds a secret prompt doesn't resize the agent either. */}
            <p className="flex h-15 items-center gap-1.5 px-3.5 text-xs text-text-secondary">
              <KeyRound className="size-3.5 shrink-0" aria-hidden="true" />
              It's asking for a secret: type it straight into the terminal above
            </p>
            <div aria-hidden="true" className="h-6" />
          </div>
        )}
      </div>
    </section>
  );
}
