import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  AskingCircle,
  BrandMark,
  Clock,
  DecisionsIcon,
  DoneCircle,
  ExitedCircle,
  HollowCircle,
} from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { CountBadge } from "@/components/ui/badge";
import { ArrowRight, ChevronRight } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { FactRun } from "@/components/ui/FactSeparator";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import { decisionsClient } from "@/clients/decisionsClient";
import { terminalClient } from "@/clients/terminalClient";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";
import { useDecisionsSwitch } from "@/hooks/useDecisionsOn";
import { currentHostId, isRemoteWindow } from "@/hooks/useHostPlatform";
import { useRovingRows } from "@/hooks/useRovingRows";
import { listStepOf } from "@/lib/listStepChord";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { resolveAgentIcon } from "@/config/agentIcons";
import { getBrandColorHex } from "@/lib/colorUtils";
import { pluralize } from "@/lib/pluralize";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { worktreeDisplayName } from "@/utils/recipeScope";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isScratchWorkspaceId } from "@shared/utils/workspaceIds";
import type { WorktreeSnapshot } from "@shared/types";
import type { DecisionsStatus } from "@shared/types/decisions";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";
import {
  ATTENTION_ACTIONS,
  AttentionActionRow,
  AttentionConfirmations,
  ResumePending,
  useWorktreeNames,
} from "./AttentionActions";
import { DecisionAskingPane } from "./DecisionAskingPane";
import { DecisionCancelDialog } from "./DecisionCancelDialog";
import { DecisionsInvolvementSection } from "./DecisionsInvolvementSection";
import { DecisionQuestionReadView } from "./DecisionQuestionReader";
import { asksByDeadline, deadlineMs, expiryText } from "./decisionDeadline";
import { useDecisionsClock } from "./useDecisionsClock";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { aliasLabel } from "./decisionQuestionModel";
import { referencedQuestion, type DecisionQuestionTarget } from "./decisionQuestionTarget";
import {
  agentName,
  askerNotes,
  askShownIn,
  askedOnHost,
  attentionNotice,
  attentionText,
  CLEAR_GONE_HINT,
  CLEARED_ELAPSED_NOTE,
  CLEARED_NOTE,
  clearAllText,
  clearGoneText,
  clearText,
  connectionNotice,
  DECLINE_TEXT,
  ELAPSED_NOTE,
  emptyText,
  expiresSoon,
  findAsked,
  folds,
  GO_TO_TERMINAL_TEXT,
  goneAsks,
  hiddenIn,
  inboxGroupOf,
  inboxGroups,
  closedTime,
  headerFacts,
  inboxRowNote,
  inWindowProject,
  isAttention,
  isClosed,
  markedText,
  originFacts,
  paneTitle,
  questionOfKey,
  referenceKey,
  replyLine,
  replyLineKey,
  replyToShow,
  resolveSelection,
  RETRY_DECLINE_TEXT,
  scopedQuestions,
  scopeOffered,
  shownItems,
  standingText,
  waitingText,
  whereFacts,
  worktreeName,
  WITHDRAW_TEXT,
  type InboxChoice,
  type InboxGroup,
  type InboxGroupId,
  type InboxReach,
  type QuestionOrigin,
  type InboxScope,
  type WindowProject,
} from "./decisionsInboxModel";
import {
  useDecisionQuestionReader,
  useDecisionsReaderRetention,
  useQuestionCancel,
  type TaggedRead,
} from "./useDecisionQuestionReader";
import { useAttentionActions } from "./useAttentionActions";
import { useDecisionQuestionSeen } from "./useDecisionQuestionSeen";
import { replyRequest } from "./decisionFollowUpModel";
import { useInboxAttentionItem } from "./useInboxAttentionItem";
import {
  HostAttentionActions,
  HostAttentionStatus,
  useHostAttention,
} from "./HostAttentionActions";
import { useThreadMessageScroll } from "./useThreadMessageScroll";

/** A pane's Decisions chip, where the close returns when the inbox was opened from it. */
const PANE_CHIP = '[data-testid="terminal-decisions-chip"]';

/** The IPC read takes at most this many references at once. */
const SUMMARY_BATCH = 64;

/** While another project's question is shown, how often its terminal is looked for again. */
const REACH_RECHECK_MS = 15_000;

/**
 * How long the arrow keys rest on a row before its question shows (#18038):
 * long enough that arrowing past a row reads nothing and marks nothing seen.
 */
const SELECTION_DWELL_MS = 300;

/** Where the keyboard goes in a question it's sent to: its words, or its answer. */
type FocusDestination = "words" | "answer";

/**
 * The answer's first control, as Tab would reach it: the choice made, else the
 * first that can be made, else its field. Null when it takes no answer here.
 */
function answerControl(scope: HTMLElement): HTMLElement | null {
  const answer = scope.querySelector<HTMLElement>("[data-decision-answer]");
  if (answer === null) return null;
  return (
    answer.querySelector<HTMLElement>('input[type="radio"]:checked:not(:disabled)') ??
    answer.querySelector<HTMLElement>('input[type="radio"]:not(:disabled)') ??
    answer.querySelector<HTMLElement>("textarea")
  );
}

/** Puts the keyboard in the question shown: its answer when sent there and it takes one, else its words. */
function landIn(detail: HTMLElement, wordsId: string, to: FocusDestination): void {
  const control = to === "answer" ? answerControl(detail) : null;
  // Scrolled to, since the answer can sit below the images.
  if (control !== null) control.focus();
  else (document.getElementById(wordsId) ?? detail).focus({ preventScroll: true });
}

/** Brings a question's row into the list's view once it has rendered as chosen. */
function revealRow(key: string): void {
  requestAnimationFrame(() => {
    document
      .querySelector(`[data-inbox-key="${encodeURIComponent(key)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
}

/** The inbox's two lists once it holds more than the window's project (#18051), named as prompt history names them. */
const SCOPE_OPTIONS: SegmentedRadioOption<InboxScope>[] = [
  { value: "all", label: "All projects" },
  { value: "project", label: "This project" },
];

/**
 * How long a question asked for while a layer over the inbox held the keyboard
 * waits for that layer to hand it back (the palette closing as it runs the
 * action), before the row it was going to keeps only its place in view.
 */
const LAYER_HANDBACK_MS = 1_000;

type ListRead =
  { state: "loading" } | { state: "failed" } | { state: "listed"; list: DecisionQuestionList };

const LOADING: ListRead = { state: "loading" };
const NO_LINES: ReadonlyMap<string, string | null> = new Map();
const NO_QUESTIONS: readonly DecisionQuestionListItem[] = [];
const NO_GROUPS: ReadonlySet<InboxGroupId> = new Set();
const NO_WORKTREES = new Map<string, WorktreeSnapshot>();

/** A pane on this computer, by the project and terminal a question names it by. */
function paneKey(projectId: string, terminalId: string): string {
  return `${projectId}\u0000${terminalId}`;
}

const BAR_PREFIX = "group:";

/** A folding group's bar among the rows the arrow keys walk; a question's key always has separators. */
function barKey(id: InboxGroupId): string {
  return `${BAR_PREFIX}${id}`;
}

function isBarKey(key: string): boolean {
  return key.startsWith(BAR_PREFIX) && !key.includes("\u0000");
}

/** What the list's arrow keys walk, in order: a folding group's bar, then its rows while it's open. */
function listStops(groups: readonly InboxGroup[], open: ReadonlySet<InboxGroupId>): string[] {
  return groups.flatMap((group) => [
    ...(folds(group.id) ? [barKey(group.id)] : []),
    ...(folds(group.id) && !open.has(group.id)
      ? []
      : group.items.map((item) => referenceKey(item.reference))),
  ]);
}

/**
 * The drawn question a step from `fromKey` lands on, over the bars between: the
 * first or last when it starts from nothing listed, itself at the list's ends,
 * and null from a bar with no question past it.
 */
function stepFrom(stops: readonly string[], fromKey: string | null, step: -1 | 1): string | null {
  const questions = stops.filter((key) => !isBarKey(key));
  if (questions.length === 0) return null;
  const from = fromKey === null ? -1 : stops.indexOf(fromKey);
  if (from === -1) return step > 0 ? questions[0]! : questions[questions.length - 1]!;
  for (let at = from + step; at >= 0 && at < stops.length; at += step) {
    if (!isBarKey(stops[at]!)) return stops[at]!;
  }
  return isBarKey(stops[from]!) ? null : stops[from]!;
}

/**
 * This computer's questions while the inbox is open and Decisions is on, as
 * this opening read them: a list from an earlier opening is never shown, so
 * the first question picked is one this opening listed. `retry` watches afresh.
 */
function useQuestionList(
  active: boolean,
  opening: number
): { read: ListRead; retry: () => void; release: () => void } {
  const [read, setRead] = useState<{ opening: number; read: ListRead } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    return decisionsClient.watchQuestions(
      (list) => setRead({ opening, read: { state: "listed", list } }),
      () => setRead({ opening, read: { state: "failed" } })
    );
  }, [active, opening, attempt]);
  const retry = useCallback(() => {
    setRead(null);
    setAttempt((n) => n + 1);
  }, []);
  const release = useCallback(() => setRead(null), []);
  return { read: read !== null && read.opening === opening ? read.read : LOADING, retry, release };
}

/**
 * Decisions' status while the inbox is open, as this opening read it. `known`
 * once a status arrived or the read failed, so nothing waits on it for good.
 */
function useInboxStatus(
  active: boolean,
  opening: number
): { status: DecisionsStatus | null; known: boolean } {
  const [read, setRead] = useState<{ opening: number; status: DecisionsStatus | null } | null>(
    null
  );
  useEffect(() => {
    if (!active) return;
    return decisionsClient.watchStatus(
      (next) => setRead({ opening, status: next }),
      () => setRead({ opening, status: null })
    );
  }, [active, opening]);
  const current = active && read !== null && read.opening === opening ? read : null;
  return { status: current?.status ?? null, known: current !== null };
}

/**
 * Each listed question's opening line, read by reference while the inbox is
 * open, once per question per opening and held only in memory. A batch that
 * couldn't be read is asked again with the next change to the list; a line
 * that can't be read leaves its row named by alias.
 */
function useQuestionLines(
  items: readonly DecisionQuestionListItem[],
  active: boolean
): { lines: ReadonlyMap<string, string | null>; release: () => void } {
  const [lines, setLines] = useState(NO_LINES);
  const asked = useRef(new Set<string>());
  const opening = useRef(0);

  // Anything still on its way belongs to the opening, or the mount, that ended.
  const forget = useCallback(() => {
    opening.current += 1;
    asked.current = new Set();
  }, []);
  useEffect(() => forget, [forget]);

  // The rows drawn now, for a read that spans batches: one a fold hid since isn't read (#18023).
  // Synced with the commit, so a batch resuming before passive effects run still sees it.
  const drawn = useRef(items);
  useLayoutEffect(() => {
    drawn.current = items;
  }, [items]);

  useEffect(() => {
    if (!active) {
      forget();
      return;
    }
    const missing = items.filter((item) => !asked.current.has(referenceKey(item.reference)));
    if (missing.length === 0) return;
    for (const item of missing) asked.current.add(referenceKey(item.reference));
    const thisOpening = opening.current;
    void (async () => {
      for (let start = 0; start < missing.length; start += SUMMARY_BATCH) {
        const still = new Set(drawn.current.map((item) => referenceKey(item.reference)));
        const batch = missing.slice(start, start + SUMMARY_BATCH).filter((item) => {
          const key = referenceKey(item.reference);
          // Asked again once its row is drawn.
          if (!still.has(key)) asked.current.delete(key);
          return still.has(key);
        });
        if (batch.length === 0) continue;
        const result = await decisionsClient
          .getQuestionSummariesByReference(batch.map((item) => item.reference))
          .catch(() => null);
        if (thisOpening !== opening.current) return;
        if (result === null || result.result !== "read") {
          for (const item of batch) asked.current.delete(referenceKey(item.reference));
          continue;
        }
        const byId = new Map(result.summaries.map((summary) => [summary.questionId, summary]));
        setLines((previous) => {
          const next = new Map(previous);
          for (const item of batch) {
            const summary = byId.get(item.reference.questionId);
            next.set(
              referenceKey(item.reference),
              summary?.result === "read" ? summary.line : null
            );
          }
          return next;
        });
      }
    })();
  }, [active, items, forget]);

  const release = useCallback(() => setLines(NO_LINES), []);
  return { lines, release };
}

/**
 * The opening line of each listed request for a reply (#18040), while its
 * question waits on the person for one: read from that question's own thread
 * by reference, once per request per opening (`replyLineKey`), and held only
 * in memory. Only these rows, so everywhere else a question is named by its
 * own words. A read that fails, or doesn't hold the request yet, is tried
 * again with the next change to the list; a request it holds without words
 * that can be read leaves the question's line.
 */
function useReplyLines(
  items: readonly DecisionQuestionListItem[],
  active: boolean
): { lines: ReadonlyMap<string, string | null>; release: () => void } {
  const [lines, setLines] = useState(NO_LINES);
  const asked = useRef(new Set<string>());
  const opening = useRef(0);
  // Each new list, never a retry: a read that fails after a newer list came asks again at once,
  // and only once for that list, so reads that keep failing never keep each other going.
  const lists = useRef<{ items: readonly DecisionQuestionListItem[] | null; count: number }>({
    items: null,
    count: 0,
  });
  const [retries, setRetries] = useState(0);

  const forget = useCallback(() => {
    opening.current += 1;
    asked.current = new Set();
  }, []);
  useEffect(() => forget, [forget]);

  useEffect(() => {
    if (!active) {
      forget();
      return;
    }
    if (lists.current.items !== items) lists.current = { items, count: lists.current.count + 1 };
    const thisList = lists.current.count;
    const missing = items.flatMap((item) => {
      const key = replyLineKey(item);
      const ask = replyToShow(item);
      return key === null || ask === null || asked.current.has(key)
        ? []
        : [{ key, ask, reference: item.reference }];
    });
    const thisOpening = opening.current;
    // Each on its own, so one slow Host holds up no other row.
    for (const { key, ask, reference } of missing) {
      asked.current.add(key);
      void (async () => {
        const read = await decisionsClient
          .getQuestionContentByReference(reference)
          .catch(() => null);
        if (thisOpening !== opening.current) return;
        // Not read, or read before it held the request: asked again with the list's next change.
        const holds =
          read?.result === "read" &&
          read.question.thread.some((entry) => entry.type === "message" && entry.messageId === ask);
        if (!holds) {
          asked.current.delete(key);
          if (lists.current.count !== thisList) setRetries((count) => count + 1);
          return;
        }
        const line = replyLine(read.question, ask);
        setLines((previous) => new Map(previous).set(key, line));
      })();
    }
  }, [active, items, forget, retries]);

  const release = useCallback(() => setLines(NO_LINES), []);
  return { lines, release };
}

/** Where the terminal that asked can be gone to: in this view, or in another project's. */
type TerminalReach = "here" | "elsewhere" | null;

/** Whether this computer still runs another project's terminal, out of the trash. */
async function runsTerminal(terminalId: string, projectId: string): Promise<boolean> {
  const terminals = await terminalClient.getAll();
  return terminals.some(
    (terminal) =>
      terminal.id === terminalId &&
      terminal.projectId === projectId &&
      terminal.isTrashed !== true &&
      terminal.hasPty !== false
  );
}

/**
 * Whether the terminal that asked the question is still open, on the machine
 * this view works on (#18049): this view's own panels answer for its project,
 * as they change, in a Remote Host's window too. For another project of this
 * computer's, the terminals it runs, looked for again a while after each look
 * settles; a Remote Host window's other projects aren't looked for. A
 * question another machine asked offers nothing, whatever its ids.
 */
function useTerminalReach(
  item: DecisionQuestionListItem | null,
  active: boolean
): { reach: TerminalReach; markGone: (key: string) => void } {
  const remote = isRemoteWindow();
  const sameMachine = item !== null && askedOnHost(item, currentHostId());
  // The terminal that asked was seen to close or run another session: a pane under its id isn't it.
  const target = item?.asker?.target;
  const gone = target === "closed" || target === "trashed" || target === "replaced";
  const terminalId = gone ? null : (item?.reference.terminalId ?? null);
  const projectId = gone ? null : (item?.reference.projectId ?? null);
  const here = sameMachine && projectId !== null && projectId === getViewWorkspaceId();
  const openHere = usePanelStore((state) => {
    if (!here || terminalId === null) return false;
    const panel = state.panelsById[terminalId];
    return panel !== undefined && panel.location !== "trash";
  });
  const key = item === null ? null : referenceKey(item.reference);
  const [found, setFound] = useState<{ key: string; open: boolean } | null>(null);
  // Rises when a click finds the terminal gone: the looks in flight are older, and are dropped.
  const [epoch, setEpoch] = useState(0);
  const looks = useRef(0);

  useEffect(() => {
    if (
      !active ||
      remote ||
      !sameMachine ||
      here ||
      key === null ||
      terminalId === null ||
      projectId === null
    ) {
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const mine = looks.current;
    // One look at a time, so an older answer never lands after a newer one.
    const look = () => {
      const settle = (open: boolean) => {
        if (!live || mine !== looks.current) return;
        setFound({ key, open });
        timer = setTimeout(look, REACH_RECHECK_MS);
      };
      runsTerminal(terminalId, projectId).then(settle, () => settle(false));
    };
    look();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, remote, sameMachine, here, key, terminalId, projectId, epoch]);

  const markGone = useCallback((gone: string) => {
    looks.current += 1;
    setFound({ key: gone, open: false });
    setEpoch((n) => n + 1);
  }, []);
  if (item === null || !sameMachine || gone) return { reach: null, markGone };
  if (here) return { reach: openHere ? "here" : null, markGone };
  if (remote) return { reach: null, markGone };
  return {
    reach: found !== null && found.key === key && found.open ? "elsewhere" : null,
    markGone,
  };
}

function ListSkeleton() {
  // The shape of what loads: a group's bar, then rows with their lead column and two lines.
  return (
    <Skeleton label="Loading questions" className="flex flex-col">
      <div className="flex h-9 items-center px-3">
        <SkeletonBone className="h-2.5 w-20" />
      </div>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex gap-3 px-3 py-2.5">
          <SkeletonBone className="h-4 w-10" />
          <div className="flex flex-1 flex-col gap-2">
            <SkeletonBone className="h-3.5 w-full" />
            <SkeletonBone className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </Skeleton>
  );
}

/** The agent that asked, by its own mark: which agent it is, without the word on every row. */
function AgentMark({ agentKind, className }: { agentKind: string; className?: string }) {
  const config = getEffectiveAgentConfig(agentKind);
  const Icon = resolveAgentIcon(config?.iconId ?? agentKind);
  return (
    <BrandMark brandColor={getBrandColorHex(agentKind)}>
      <Icon className={cn("size-3.5", className)} />
    </BrandMark>
  );
}

const STATE_GLYPH = "size-3.5 shrink-0";
const WarningGlyph = SEVERITY_GLYPH.warning;

/**
 * Where the question stands, in the app's agent-state vocabulary: the waiting
 * ring with a question mark while it asks the person, the ring alone while an
 * answer waits to be typed in, the warning shape when delivery needs a person,
 * and the finished or ended ring once it is over. A question the person set
 * aside is still an open ask, so it keeps its question mark, but not the
 * amber that is kept for what waits on them.
 */
function StandingGlyph({
  standing,
  cleared,
}: {
  standing: DecisionQuestionStanding;
  cleared: boolean;
}) {
  switch (standing.kind) {
    case "waiting":
    case "queued":
      return (
        <AskingCircle
          className={cn(STATE_GLYPH, cleared ? "text-text-secondary" : "text-state-waiting")}
        />
      );
    case "to-type":
      return <HollowCircle className={cn(STATE_GLYPH, "text-text-secondary")} />;
    case "needs-attention":
      return <WarningGlyph className={cn(STATE_GLYPH, "text-status-warning")} />;
    case "settled":
      return standing.outcome === "answered" ? (
        <DoneCircle className={cn(STATE_GLYPH, "text-text-secondary")} />
      ) : (
        <ExitedCircle className={cn(STATE_GLYPH, "text-text-secondary")} />
      );
    case "send-failed":
      return <ExitedCircle className={cn(STATE_GLYPH, "text-text-secondary")} />;
  }
}

/**
 * One of the detail bar's actions, saying what it does before it's pressed
 * (#18041): on hover and focus, and as its description to the ear.
 */
function DescribedAction({
  description,
  ref,
  ...props
}: ButtonProps & { description: string; ref?: Ref<HTMLButtonElement> }) {
  const descriptionId = useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button ref={ref} {...props} aria-describedby={descriptionId} />
        </TooltipTrigger>
        <TooltipContent>{description}</TooltipContent>
      </Tooltip>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </>
  );
}

function InboxRow({
  item,
  rowKey,
  line,
  origin,
  selected,
  describedBy,
  tabStop,
  rowRef,
  onFocus,
  onSelect,
  onAnswer,
  nowMs,
}: {
  item: DecisionQuestionListItem;
  rowKey: string;
  line: string | null;
  origin: QuestionOrigin;
  selected: boolean;
  /** The list's keys, said with the row Tab lands on: the region's own description isn't read there. */
  describedBy: string | undefined;
  tabStop: boolean;
  rowRef: (element: HTMLElement | null) => void;
  onFocus: (element: HTMLElement) => void;
  onSelect: () => void;
  onAnswer: () => void;
  nowMs: number | null;
}) {
  const note = inboxRowNote(item, nowMs);
  const shownTime =
    inboxGroupOf(item, nowMs) === "history"
      ? closedTime(item)
      : { at: item.askedAt, kind: "asked" as const };
  const cleared = inboxGroupOf(item, nowMs) === "cleared";
  const deadline = deadlineMs(item.expiresAt);
  // Within a day: when, in this computer's time, and how long is left (#17943).
  const expiry =
    deadline !== null && nowMs !== null && expiresSoon(item, nowMs)
      ? expiryText(deadline, nowMs, item.replyMode)
      : null;
  const asker = askerNotes(item);
  const closed = isClosed(item.standing);
  const attention = isAttention(item.standing);
  // Set aside, not over: the title steps down like History's, the question stays open.
  const quiet = closed || cleared;
  // Past its deadline it no longer waits on the person, and the ear hears that, not an invitation to answer.
  const spoken =
    inboxGroupOf(item, nowMs) === "awaiting"
      ? note
      : note === CLEARED_ELAPSED_NOTE
        ? ELAPSED_NOTE
        : standingText(item.standing, item);
  return (
    <li>
      <button
        type="button"
        ref={rowRef}
        // One tab stop for the whole list; the arrow keys move it.
        tabIndex={tabStop ? 0 : -1}
        aria-current={selected || undefined}
        aria-describedby={describedBy}
        data-roving-row=""
        data-inbox-key={encodeURIComponent(rowKey)}
        data-selected={selected ? "true" : undefined}
        onFocus={(event) => onFocus(event.currentTarget)}
        onClick={onSelect}
        // Across to the question beside the list, into its answer. Enter and Space stay the button's.
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          onAnswer();
        }}
        className="decisions-inbox-row flex w-full cursor-pointer items-stretch gap-3 px-3 py-2.5 text-left"
        data-testid="decisions-inbox-row"
      >
        {/* The leading column: where it stands, and whose agent asked. */}
        <span aria-hidden="true" className="flex h-5 w-10 shrink-0 items-center gap-2">
          <span className="flex size-4 items-center justify-center">
            <StandingGlyph standing={item.standing} cleared={cleared} />
          </span>
          <span className="flex size-4 items-center justify-center">
            <AgentMark agentKind={item.agentKind} />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-start gap-3">
            <span
              className={cn(
                "min-w-0 flex-1 text-sm leading-5 [text-wrap:pretty]",
                // History and Cleared are recognised, not triaged: one line of scent is enough.
                quiet ? "line-clamp-1 text-text-secondary" : "line-clamp-2 text-text-primary"
              )}
              data-testid="decisions-inbox-row-line"
            >
              {line ?? aliasLabel(item.alias)}
            </span>
            {/* History sorts by when a question closed, so it shows that time (#18025). */}
            <span className="shrink-0 text-xs leading-5 text-text-secondary tabular-nums">
              <span className="sr-only">
                {shownTime.kind === "closed" ? "Closed, " : "Asked, "}
              </span>
              <TimeAgo timestamp={shownTime.at} />
            </span>
          </span>
          {/* Only what sets this row apart from its group; the full sentence is for the ear.
              A closed row's outcome follows who asked on its where-line instead, so history stays two lines. */}
          {((note !== null && !closed) || expiry !== null || asker !== null) && (
            <span
              aria-hidden="true"
              className={cn(
                // Wraps rather than squeeze what was seen of the asker out past a deadline chip.
                "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-4",
                attention || expiry !== null ? "text-text-primary" : "text-text-secondary"
              )}
            >
              {expiry !== null && (
                // A deadline inside a day: the one chip a waiting row wears, as on the phone.
                <span className="flex min-w-0 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] bg-overlay-soft px-1.5 py-0.5 font-medium">
                  <Clock
                    className={cn(
                      "size-3 shrink-0",
                      cleared ? "text-text-secondary" : "text-status-warning"
                    )}
                  />
                  <span className="truncate">{expiry}</span>
                </span>
              )}
              {note !== null && !closed && <span className="min-w-0 truncate">{note}</span>}
              {asker !== null && (
                <span className="min-w-0 truncate" data-testid="decisions-inbox-row-asker">
                  {asker.row}
                </span>
              )}
            </span>
          )}
          {/* A closed row's outcome is already read out with its where-line. */}
          {!(closed && note !== null) && (
            <span className="sr-only">
              {spoken}
              {cleared && `, ${CLEARED_NOTE.toLowerCase()}`}
              {expiry !== null && `, ${expiry.toLowerCase()}`}
              {asker !== null && `, ${asker.row.toLowerCase()}`}
            </span>
          )}
          <span className="flex h-4 min-w-0 items-center gap-3 text-xs leading-4 text-text-secondary">
            {/* Who asked leads; the place, ending with the project, gives way first. */}
            <span className="min-w-0 flex-1 truncate" data-testid="decisions-inbox-row-origin">
              <FactRun facts={originFacts(origin, closed ? note : null)} />
            </span>
            {/* Not twice: a row whose line couldn't be read is already named by it. */}
            {line !== null && (
              <span
                className="shrink-0 font-mono text-2xs tabular-nums"
                data-testid="decisions-inbox-row-alias"
              >
                {aliasLabel(item.alias)}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The grouped list, one tab stop with the arrow keys moving it, mounted only
 * while the dialog is: what it holds of the rows goes with the close.
 */
function InboxList({
  listRef,
  lead,
  groups,
  open,
  onFold,
  lines,
  replyLines,
  partsOf,
  selectedKey,
  onSelect,
  onAnswer,
  nowMs,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  /** Above the groups: what the list says when it has nothing, or that nothing waits (#18022). */
  lead: ReactNode;
  groups: readonly InboxGroup[];
  /** The folding groups this opening has open; the rest of History and Cleared are shut. */
  open: ReadonlySet<InboxGroupId>;
  onFold: (id: InboxGroupId, open: boolean) => void;
  lines: ReadonlyMap<string, string | null>;
  /** A request for a reply's line, by `replyLineKey`, in place of its question's. */
  replyLines: ReadonlyMap<string, string | null>;
  partsOf: (item: DecisionQuestionListItem) => QuestionOrigin;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Show this row's question now and take the keyboard into its answer. */
  onAnswer: (key: string) => void;
  nowMs: number | null;
}) {
  const labelId = useId();
  const hintId = useId();
  const barHintId = useId();
  const shut = (id: InboxGroupId) => folds(id) && !open.has(id);
  const keys = listStops(groups, open);
  // The question shown, under a shut group, is reached through that group's bar.
  const selectedShut = selectedKey === null ? null : hiddenIn(groups, selectedKey, open);
  const roving = useRovingRows({
    keys,
    preferredKey: selectedShut !== null ? barKey(selectedShut) : selectedKey,
    containerRef: listRef,
  });
  // The list's keys, said with the stop Tab lands on: the region's own description isn't read there.
  // The stop itself while the question shown has no row drawn or a bar holds the stop, so Tab back
  // from a group shut and opened again still hears it.
  const barStop = roving.tabStopKey !== null && isBarKey(roving.tabStopKey);
  const hintKey =
    selectedKey === null || selectedShut !== null || barStop ? roving.tabStopKey : selectedKey;
  // The row the keyboard was on, until focus goes somewhere else on purpose.
  const lastFocused = useRef<{ key: string; element: HTMLElement } | null>(null);
  // The arrows' rest before the row they reached shows. Armed only by the list's own keys:
  // a click shows at once, and focus put back on a row (a regroup, a dialog closing) shows nothing new.
  const dwell = useRef<{ timer?: ReturnType<typeof setTimeout> }>({});
  useEffect(() => {
    const held = dwell.current;
    return () => clearTimeout(held.timer);
  }, []);

  // Started by each press that moves the keyboard to a row, for the row it moved to. A bar shows
  // no question, so resting on one shows nothing.
  const armDwell = () => {
    clearTimeout(dwell.current.timer);
    const landed = lastFocused.current;
    if (landed === null || landed.key === selectedKey || isBarKey(landed.key)) return;
    dwell.current.timer = setTimeout(() => {
      const now = lastFocused.current;
      // Only while the keyboard is still on it: another press, a blur, or its row going ends it.
      if (now === null || now.key !== landed.key || document.activeElement !== now.element) return;
      onSelect(now.key);
    }, SELECTION_DWELL_MS);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    roving.onKeyDown(event);
    if (event.isDefaultPrevented()) armDwell();
  };
  const renderRow = (item: DecisionQuestionListItem) => {
    const key = referenceKey(item.reference);
    const replyKey = replyLineKey(item);
    return (
      <InboxRow
        key={key}
        item={item}
        rowKey={key}
        // The question's line until its request's is read, and where that can't be.
        line={(replyKey === null ? null : replyLines.get(replyKey)) ?? lines.get(key) ?? null}
        origin={partsOf(item)}
        selected={key === selectedKey}
        describedBy={key === hintKey ? hintId : undefined}
        tabStop={key === roving.tabStopKey}
        rowRef={roving.rowRef(key)}
        onFocus={(element) => {
          lastFocused.current = { key, element };
          roving.onRowFocus(key);
        }}
        onSelect={() => onSelect(key)}
        onAnswer={() => {
          clearTimeout(dwell.current.timer);
          onAnswer(key);
        }}
        nowMs={nowMs}
      />
    );
  };

  // A row that moves to another group is a new element, and the old one took
  // focus with it; the keyboard goes back to the row, to the bar of the shut
  // group it went into, or to the list's stop.
  useLayoutEffect(() => {
    const last = lastFocused.current;
    const list = listRef.current;
    // Only for the row that went: one still in place lost focus some other way.
    if (last === null || list === null || last.element.isConnected) return;
    lastFocused.current = null;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) return;
    const at = (key: string) =>
      list.querySelector<HTMLElement>(`[data-inbox-key="${encodeURIComponent(key)}"]`);
    const into = hiddenIn(groups, last.key, open);
    const shutBar = into === null ? null : at(barKey(into));
    // The bar can sit far from where the row was, so it comes into view with the keyboard.
    if (at(last.key) === null && shutBar !== null) {
      shutBar.focus();
      return;
    }
    const row = at(last.key) ?? list.querySelector<HTMLElement>('[data-roving-row][tabindex="0"]');
    row?.focus({ preventScroll: true });
  }, [groups, open, listRef]);

  return (
    <div
      ref={listRef}
      onKeyDown={(event) => {
        // On the list itself (it had no rows, or a click on its blank space), the first arrow
        // goes to the row Tab would reach, rather than one past it.
        if (
          event.target === event.currentTarget &&
          (event.key === "ArrowDown" || event.key === "ArrowUp") &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          const stop = event.currentTarget.querySelector<HTMLElement>(
            '[data-roving-row][tabindex="0"]'
          );
          if (stop !== null) {
            event.preventDefault();
            stop.focus();
            armDwell();
            return;
          }
        }
        onKeyDown(event);
      }}
      // The dialog's first stop while it has no rows, so the keyboard still starts on the list; with
      // rows, the rows are, and the list only holds focus a row it lost (or a control under it) hands back.
      tabIndex={keys.length === 0 ? 0 : -1}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) {
          lastFocused.current = null;
          // Gone somewhere else on purpose: coming back is not resting on it.
          clearTimeout(dwell.current.timer);
        } else if (next === null) {
          // Focus left for nowhere: a row a regroup replaced is gone by the
          // next task, and one still in place was blurred some other way.
          const left = lastFocused.current;
          setTimeout(() => {
            if (left !== null && lastFocused.current === left && left.element.isConnected) {
              lastFocused.current = null;
            }
          }, 0);
        }
        roving.containerProps.onBlur(event);
      }}
      role="region"
      aria-labelledby={labelId}
      className="flex flex-1 flex-col outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
      data-testid="decisions-inbox-groups"
    >
      <span id={labelId} className="sr-only">
        Questions
      </span>
      <span id={hintId} className="sr-only">
        Up and down arrows show each question. Right arrow moves into it.
      </span>
      {/* A bar opens no question to move into. */}
      <span id={barHintId} className="sr-only">
        Up and down arrows show each question.
      </span>
      {lead}
      {groups.map((group) => {
        const headingId = `${labelId}-${group.id}`;
        const rowsId = `${headingId}-rows`;
        const stopped = groups.find((other) => other.id === "attention")?.items.length ?? 0;
        const label = (
          <>
            {group.title}
            <CountBadge label={pluralize(group.items.length, "question")}>
              {group.items.length.toLocaleString()}
            </CountBadge>
          </>
        );
        if (folds(group.id)) {
          const key = barKey(group.id);
          const expanded = !shut(group.id);
          return (
            <section
              key={group.id}
              aria-labelledby={headingId}
              className="flex flex-col"
              data-testid={`decisions-inbox-group-${group.id}`}
            >
              {/* Canopy's folding bar: its count stays in view while the group is shut. */}
              <h3 id={headingId} className="decisions-inbox-heading flex h-9 w-full shrink-0">
                <button
                  type="button"
                  ref={roving.rowRef(key)}
                  tabIndex={key === roving.tabStopKey ? 0 : -1}
                  aria-expanded={expanded}
                  aria-controls={rowsId}
                  aria-describedby={key === hintKey ? barHintId : undefined}
                  data-roving-row=""
                  data-inbox-key={encodeURIComponent(key)}
                  onFocus={(event) => {
                    lastFocused.current = { key, element: event.currentTarget };
                    roving.onRowFocus(key);
                  }}
                  // The keyboard on a row it shuts goes to the bar with the layout effect above.
                  onClick={() => onFold(group.id, !expanded)}
                  className="decisions-inbox-fold flex w-full cursor-pointer items-center justify-between gap-1.5 px-3 text-left outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
                  data-testid={`decisions-inbox-fold-${group.id}`}
                >
                  <span className={cn(PALETTE_SECTION_LABEL_CLASS, "flex items-center gap-1.5")}>
                    {label}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 shrink-0 text-text-secondary transition-transform duration-150 motion-reduce:transition-none",
                      expanded && "rotate-90"
                    )}
                  />
                </button>
              </h3>
              <ul id={rowsId} hidden={!expanded} className="flex flex-col">
                {expanded && group.items.map((item) => renderRow(item))}
              </ul>
            </section>
          );
        }
        return (
          <section
            key={group.id}
            aria-labelledby={headingId}
            className="flex flex-col"
            data-testid={`decisions-inbox-group-${group.id}`}
          >
            {/* Canopy's section bar: the group's name and count, held at the top while its rows scroll. */}
            <div className="decisions-inbox-heading flex h-9 w-full shrink-0 items-center justify-between gap-1.5 px-3">
              <h3
                id={headingId}
                className={cn(PALETTE_SECTION_LABEL_CLASS, "flex items-center gap-1.5")}
              >
                {label}
              </h3>
              {/* Stopped deliveries can sit below a long queue: one click takes the list to them.
                  A pointer shortcut only; the keyboard reaches them with the list's own keys. */}
              {group.id === "needs-you" && stopped > 0 && (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() =>
                    listRef.current
                      ?.querySelector('[data-testid="decisions-inbox-group-attention"]')
                      ?.scrollIntoView({ block: "start" })
                  }
                  className="flex h-6 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-xs text-text-secondary transition-colors duration-150 hover:bg-overlay-highlight hover:text-text-primary"
                  data-testid="decisions-inbox-jump-attention"
                >
                  <WarningGlyph className="size-3 text-status-warning" />
                  {stopped.toLocaleString()} stopped
                </button>
              )}
            </div>
            <ul className="flex flex-col">{group.items.map((item) => renderRow(item))}</ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Every question this computer's Decisions holds (#17231), across its
 * projects and terminals, or only the window's project's once narrowed to it
 * (#18051), grouped by what it needs: the person, delivery, or a decision
 * about a stopped delivery, then history. Selecting one reads it
 * in full beside the list, with the question view's answer and dismissal, and
 * a way to the terminal that asked while it is still open. The words are
 * read on demand by reference and held in memory only while it is open.
 */
export function DecisionsInboxDialog() {
  const isOpen = useDecisionsInboxStore((state) => state.isOpen);
  const request = useDecisionsInboxStore((state) => state.request);
  const close = useDecisionsInboxStore((state) => state.close);
  const on = useDecisionsSwitch() === "on";
  const active = isOpen && on;
  useDecisionsReaderRetention(isOpen, close);

  const { read: listRead, retry, release: releaseList } = useQuestionList(active, request.seq);
  const { status, known: statusKnown } = useInboxStatus(active, request.seq);
  const notice = connectionNotice(status);
  const questions = listRead.state === "listed" ? listRead.list.questions : null;
  // Moved on only when a deadline's row would read differently, or the clock jumped (#17943).
  const nowMs = useDecisionsClock(
    (questions ?? []).flatMap((item) => (asksByDeadline(item.standing) ? [item.expiresAt] : [])),
    active
  );
  const viewWorkspace = getViewWorkspaceId();
  // The project this window shows, on its own Host; a scratch workspace is no project to narrow to.
  const windowProject: WindowProject | null =
    viewWorkspace === null || isScratchWorkspaceId(viewWorkspace)
      ? null
      : { hostId: currentHostId(), projectId: viewWorkspace };
  // Each opening starts on every project, as the toolbar's count does. Once the list holds this
  // project and another, the switch stays for the opening, so a push that empties one side never
  // takes the switch from under the keyboard or quietly widens what Clear reaches.
  const offered = questions !== null && scopeOffered(questions, windowProject);
  const [scopeChoice, setScopeChoice] = useState<{ seq: number; scope: InboxScope } | null>(null);
  const openingScope =
    scopeChoice !== null && scopeChoice.seq === request.seq ? scopeChoice.scope : null;
  if (openingScope === null && offered) setScopeChoice({ seq: request.seq, scope: "all" });
  const scope: InboxScope = openingScope ?? "all";
  const showScope = questions !== null && (offered || openingScope !== null);
  const shown = questions === null ? null : scopedQuestions(questions, scope, windowProject);
  const groups = shown === null ? [] : inboxGroups(shown, nowMs);
  const ordered = groups.flatMap((group) => group.items);
  // Which of History and Cleared this opening has open (#18023), and which the person opened or
  // shut themselves. Every opening starts with both shut, so one look back doesn't leave History's
  // rows across every later visit.
  const [unfolded, setUnfolded] = useState<{
    seq: number;
    groups: ReadonlySet<InboxGroupId>;
    byPerson: ReadonlySet<InboxGroupId>;
  } | null>(null);
  const folding = unfolded !== null && unfolded.seq === request.seq ? unfolded : null;
  const openGroups = folding?.groups ?? NO_GROUPS;
  const foldedByPerson = folding?.byPerson ?? NO_GROUPS;
  const fold = (id: InboxGroupId, open: boolean, byPerson: boolean) => {
    const next = new Set(openGroups);
    if (open) next.add(id);
    else next.delete(id);
    setUnfolded({
      seq: request.seq,
      groups: next,
      byPerson: byPerson ? new Set([...foldedByPerson, id]) : foldedByPerson,
    });
  };
  // Only the rows drawn: a shut group's lines are read once it opens.
  const drawn = shownItems(groups, openGroups);
  const drawnIndexOf = (key: string) =>
    drawn.findIndex((item) => referenceKey(item.reference) === key);
  const { lines, release: releaseLines } = useQuestionLines(drawn, active);
  // The list as it came, so its next change, not every render, is what asks again; a shut
  // group's rows wait until it opens.
  const replyItems = useMemo(
    () =>
      questions === null
        ? NO_QUESTIONS
        : questions.filter((item) => {
            const id = inboxGroupOf(item, nowMs);
            return !folds(id) || openGroups.has(id);
          }),
    [questions, nowMs, openGroups]
  );
  const { lines: replyLines, release: releaseReplyLines } = useReplyLines(replyItems, active);
  // Whether Clear Needs you says how far it goes: always beside the switch, which names the list
  // shown, and otherwise once the list holds a question from outside the window's project.
  const clearNamesReach =
    showScope || (shown ?? []).some((item) => !inWindowProject(item, windowProject));

  const remote = isRemoteWindow();
  const projects = useProjectStore((state) => state.projects);
  const worktrees = useWorktreeStoreOptional((state) => state.worktrees, NO_WORKTREES);
  // Every run on this computer, across its projects: what names the pane that asked (#18039).
  // Read only while open here: the fleet moves with every retitle, and a closed inbox shows none of it.
  const runs = useFleetSnapshotStore((state) =>
    active && !remote ? (state.snapshot?.runs ?? null) : null
  );
  const runsByPane = new Map((runs ?? []).map((run) => [paneKey(run.workspaceId, run.runId), run]));
  // A Remote Host window's projects and runs are another computer's, whatever
  // their ids, as are a Host's own questions anywhere: those keep the names
  // they were asked under.
  const partsOf = (item: DecisionQuestionListItem): QuestionOrigin => {
    const own = !remote && item.remoteHost === undefined;
    const local = own && item.reference.projectId === viewWorkspace;
    const project =
      (own
        ? projects.find((candidate) => candidate.id === item.reference.projectId)?.name
        : undefined) ?? item.projectLabel;
    const known = local ? (worktreeDisplayName(worktrees.get(item.worktreeId)) ?? null) : null;
    const agent = agentName(item.agentKind);
    const run = own
      ? runsByPane.get(paneKey(item.reference.projectId, item.reference.terminalId))
      : undefined;
    return {
      agent,
      pane: run === undefined ? null : paneTitle(run, item.agentKind, agent),
      host: item.remoteHost?.name ?? null,
      away: item.remoteHost?.connected === false,
      where: whereFacts(project, worktreeName(item, known)),
    };
  };

  // A question asked for (#18047): on opening, or in this opening while it stays open.
  const asked = request.question ?? null;
  const ask = request.ask ?? 0;
  const viewHostId = currentHostId();
  // The question shown sticks to the one chosen, by reference, as the list moves around it. A
  // question asked for while open starts the choice afresh.
  const [choice, setChoice] = useState<
    (InboxChoice & { seq: number; scope: InboxScope; ask: number }) | null
  >(null);
  const chosen =
    choice !== null && choice.seq === request.seq && choice.ask === ask ? choice : null;
  // A choice made in the other list keeps its question while this one shows it, but its place
  // was in the other list: nothing here takes that place by index.
  const sameScope = chosen !== null && chosen.scope === scope;
  const selected = resolveSelection(
    groups,
    chosen === null || sameScope ? chosen : { ...chosen, picked: false },
    request.terminalId,
    viewHostId,
    windowProject,
    openGroups,
    asked
  );
  const selectedKey = selected === null ? null : referenceKey(selected.reference);
  const drawnAt = selectedKey === null ? -1 : drawnIndexOf(selectedKey);
  // Under a shut group, it keeps the place it was last drawn at.
  const selectedIndex = drawnAt >= 0 ? drawnAt : (chosen?.index ?? 0);
  if (
    selectedKey !== null &&
    (chosen === null || !sameScope || chosen.key !== selectedKey || chosen.index !== selectedIndex)
  ) {
    // One that took a picked row's place stays picked; one the inbox opened on stays its own choice,
    // as does the pane's own a vanished pick falls back to with no drawn row to take its place.
    // Across a switch, only the same question stays picked, and only once it's drawn in this list:
    // under a shut group it has no place here yet for another to take.
    setChoice({
      seq: request.seq,
      scope,
      ask,
      key: selectedKey,
      index: selectedIndex,
      picked:
        chosen?.picked === true &&
        (chosen.key === selectedKey ? sameScope || drawnAt >= 0 : sameScope && drawn.length > 0),
    });
    // Newly shown under a shut group can only be the opening pane's own question or one asked for
    // (#18047) (rows and Next question pick drawn ones): it is never hidden, so its group opens for
    // this opening, unless the person opened or shut that group themselves; one asked for opens it
    // even then, since its row takes the keyboard. One that moves into a shut group while shown,
    // cleared, closed or listed under the pane its answer was sent to, leaves the group shut.
    const stayed = chosen !== null && questionOfKey(chosen.key) === questionOfKey(selectedKey);
    const into = stayed ? null : hiddenIn(groups, selectedKey, openGroups);
    const askedFor =
      asked !== null && selected !== null && findAsked([selected], asked, viewHostId) !== undefined;
    if (into !== null && (askedFor || !foldedByPerson.has(into))) fold(into, true, false);
  } else if (selectedKey === null && chosen !== null) {
    // Gone with nothing in its place: a later list starts afresh, rather than reviving it in History.
    setChoice(null);
  }

  const askedShown =
    asked !== null && selected !== null && findAsked([selected], asked, viewHostId) !== undefined;
  // One target per question, so a push that only renews the list's objects doesn't start the
  // reader's reads over. A reply's question asked for while shown does start them over, so a read
  // begun before the ask, which can predate the follow-up it opens at, never paints.
  const [target, setTarget] = useState<{
    key: string;
    ask: number;
    target: DecisionQuestionTarget;
  } | null>(null);
  const renewsReads = asked?.threadMessageId !== undefined && askedShown;
  if (
    selected !== null &&
    selectedKey !== null &&
    (target?.key !== selectedKey || (renewsReads && target.ask !== ask))
  ) {
    setTarget({ key: selectedKey, ask, target: referencedQuestion(selected.reference) });
  }
  const shownTarget = selectedKey !== null && target?.key === selectedKey ? target.target : null;
  const reader = useDecisionQuestionReader(shownTarget, active);
  const cancel = useQuestionCancel(shownTarget, reader, isOpen);
  const { dismissal } = cancel;
  // Where a dismissal from here stands, why it can't be taken (beside Withdraw), or why it wasn't.
  const dismissNote =
    dismissal.progress !== null
      ? { text: dismissal.progress, live: true }
      : dismissal.fallback !== null
        ? { text: dismissal.fallback, live: false }
        : dismissal.outcome !== null
          ? { text: dismissal.outcome, live: true }
          : null;
  const { reach, markGone } = useTerminalReach(selected, active);
  const selectedAsker = selected === null ? null : askerNotes(selected);
  // A stopped delivery on this computer is resolved here, in the detail, rather than in a
  // second list over it (#18027). A Remote Host's stall is read and resolved through its Host.
  const attention = useInboxAttentionItem(selected, active, request.seq);
  const attentionItem = attention.read.state === "found" ? attention.read.item : null;
  const attentionWorktreeName = useWorktreeNames();
  const attentionActions = useAttentionActions({
    scope: isOpen ? `${request.seq}:${selected?.reference.questionId ?? ""}` : null,
    // A confirmation asked about a reading the stall has since moved past goes with it.
    shown: attention.stale
      ? []
      : attention.read.state === "found"
        ? [attention.read.item]
        : attention.read.state === "loading" || attention.read.state === "failed"
          ? null
          : [],
    refresh: attention.refresh,
  });
  const attentionBusy =
    selected === null ? null : (attentionActions.busy.get(selected.reference.questionId) ?? null);
  const attentionActionsRef = useRef<HTMLDivElement>(null);
  /** The control of the stall the keyboard was on, until it goes with the stall it resolved. */
  const attentionFocus = useRef<HTMLElement | null>(null);
  // What an action did stays with its question until the question stalls anew: a success it
  // reported (typed in, sent on) is no longer so once a read finds a stall it wasn't taken on.
  const attentionScope = isOpen ? `${request.seq}:${selected?.reference.questionId ?? ""}` : null;
  const attentionOutcome = attentionActions.outcome;
  const outcomeSuperseded =
    attentionOutcome !== null &&
    attentionOutcome.severity === "success" &&
    attention.read.state === "found" &&
    !attention.stale &&
    attention.read.item.token !== attentionOutcome.token;
  const { clearOutcome } = attentionActions;
  const supersededToken = outcomeSuperseded ? attentionOutcome.token : null;
  useEffect(() => {
    if (supersededToken !== null && attentionScope !== null) {
      clearOutcome(attentionScope, supersededToken);
    }
  }, [supersededToken, attentionScope, clearOutcome]);
  const hostAttention = useHostAttention(selected, active);
  const questionHeadingId = useId();
  // `reached` once its question has been the one shown, so a later choice of another abandons it.
  const pendingFocus = useRef<{
    seq: number;
    key: string;
    to: FocusDestination;
    reached?: true;
  } | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const detailHeadingId = useId();
  // Once the one shown no longer needs the person, the next that does is one press away:
  // the first they haven't seen yet, when there is one.
  const waiting = groups.find((group) => group.id === "needs-you")?.items ?? [];
  const gone = goneAsks(waiting, nowMs);
  const nextUp =
    selected !== null && inboxGroupOf(selected, nowMs) !== "needs-you"
      ? (waiting.find((item) => item.inbox?.seen !== true) ?? waiting[0] ?? null)
      : null;
  const announce = useAnnouncerStore((state) => state.announce);
  // Clearing and restoring stay on this computer: nothing is answered, declined or typed in,
  // and each question goes with the ask it was shown with, so one asking something new stays.
  const markShown = (action: "clear" | "restore", items: readonly DecisionQuestionListItem[]) => {
    const questions = items.flatMap((item) =>
      item.inbox === undefined ? [] : [{ reference: item.reference, ask: item.inbox.ask }]
    );
    if (questions.length === 0) return;
    const say = (text: string | null) => {
      if (text !== null) announce(text);
    };
    decisionsClient.markQuestions(action, questions).then(
      (result) => say(markedText(action, result)),
      () => say(markedText(action, { result: "failed" }))
    );
  };
  const selectedGroup = selected === null ? null : inboxGroupOf(selected, nowMs);
  // The question list, where the keyboard goes when a control beside it goes away under it.
  const listRef = useRef<HTMLDivElement>(null);
  // Clear Needs you goes once the group empties, by its own press or a deadline passing (#18022):
  // the keyboard on it moves to the list's stop, or the list, rather than falling to the document.
  const handBackToList = useCallback((button: HTMLElement | null) => {
    if (button === null) return;
    return () => {
      if (document.activeElement !== button) return;
      // After the commit, once the rows that replaced the group are in, and only while the inbox
      // is still open: one closing in the same commit hands focus back to where it was opened.
      queueMicrotask(() => {
        const list = listRef.current;
        if (button.isConnected || list === null || !list.isConnected) return;
        if (!useDecisionsInboxStore.getState().isOpen) return;
        const focused = document.activeElement;
        if (focused !== null && focused !== document.body) return;
        (list.querySelector<HTMLElement>('[data-roving-row][tabindex="0"]') ?? list).focus();
      });
    };
  }, []);
  const clearHintId = useId();
  const clearGoneHintId = useId();
  const clearHint = clearText(selectedGroup === "cleared");
  const choose = (key: string) => {
    setChoice({ seq: request.seq, scope, ask, key, index: drawnIndexOf(key), picked: true });
  };
  // Sends the keyboard into a question. The one already read takes it at once; another is
  // shown, and the keyboard waits in the pane until it's read (the effect below), since
  // what it was on goes with the question it followed.
  const handOff = (key: string, to: FocusDestination) => {
    const detail = detailRef.current;
    if (detail === null) return;
    choose(key);
    if (key === selectedKey && readResult !== null) {
      pendingFocus.current = null;
      // One that can't be read: the pane, on why.
      if (shownRead !== null) landIn(detail, questionHeadingId, to);
      else detail.focus({ preventScroll: true });
      return;
    }
    // Already the question shown, still being read: it has reached it.
    pendingFocus.current =
      key === selectedKey
        ? { seq: request.seq, key, to, reached: true }
        : { seq: request.seq, key, to };
    detail.focus({ preventScroll: true });
  };
  const showNext = () => {
    if (nextUp === null) return;
    const key = referenceKey(nextUp.reference);
    // To its words, so the next Tab leads into its answer. The list shows where it sits.
    handOff(key, "words");
    revealRow(key);
  };

  // Each look before going elsewhere belongs to the question shown when it
  // started, in this opening: closing, reopening, choosing another or a question
  // asked for (#18047), even the one shown, drops it.
  const navigation = useRef(0);
  // Losing the way to it drops a look too: a terminal seen to end or restart meanwhile isn't it.
  useEffect(() => {
    navigation.current += 1;
  }, [isOpen, request.seq, selectedKey, reach, ask]);

  // A hand-off's landing: once the question it asked for is read, its words or answer take the
  // keyboard, unless the keyboard went somewhere else meanwhile or another question was chosen.
  const readResult = reader.current?.result ?? null;
  const shownRead = reader.current?.result === "read" ? reader.current.question : null;
  useDecisionQuestionSeen(selected, shownRead, active, detailRef);
  // A reply's notification opens at the follow-up asking for it (#17235), once per question asked
  // for, while that question is shown and the person hasn't picked another.
  useThreadMessageScroll(
    active && askedShown && chosen?.picked !== true ? `${request.seq}:${ask}` : null,
    asked?.threadMessageId,
    reader.shownRead,
    detailRef
  );
  // Clearing waits while the read on screen predates what the list says it asks now; with
  // no read on screen (one that can't be read, its Host away) it goes by the list alone.
  const clearWaits =
    selected !== null &&
    selectedGroup === "needs-you" &&
    shownRead !== null &&
    !askShownIn(selected, shownRead);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    if (pending.seq !== request.seq || pending.key !== selectedKey) {
      // Left alone until its question has shown: it may be for one chosen after this commit,
      // whose effect comes next. Once it has, another chosen since abandons it.
      if (pending.reached) pendingFocus.current = null;
      return;
    }
    if (readResult === null) {
      if (!pending.reached) pendingFocus.current = { ...pending, reached: true };
      return;
    }
    pendingFocus.current = null;
    // One that can't be read leaves the keyboard in the pane, on why.
    const detail = detailRef.current;
    if (detail === null || document.activeElement !== detail || shownRead === null) return;
    landIn(detail, questionHeadingId, pending.to);
  }, [readResult, shownRead, selectedKey, request.seq, questionHeadingId]);

  // ⌘↑/⌘↓ (Alt+↑/↓ off the Mac) from anywhere in the inbox, as Canopy steps between agents:
  // the question above or below, stopping at the ends, with the keyboard where it was in the
  // last one: on its row, in its answer, or in the pane. Anywhere else it stays put.
  const onStepKeyDownCapture = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = listStepOf(event);
    if (step === null || !active || drawn.length === 0) return;
    const target = event.target;
    // A dialog opened over this one (an image at full size) keeps its own keys.
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    const row = target.closest<HTMLElement>("[data-roving-row]");
    const rowKey = row?.dataset.inboxKey;
    // From the row or bar the arrows rest on, before it has shown; else from the question shown,
    // or the bar of the shut group holding it. Only drawn questions are stepped to (#18023).
    const shutGroup = selectedKey === null ? null : hiddenIn(groups, selectedKey, openGroups);
    const fromKey =
      rowKey !== undefined
        ? decodeURIComponent(rowKey)
        : shutGroup !== null
          ? barKey(shutGroup)
          : selectedKey;
    const key = stepFrom(listStops(groups, openGroups), fromKey, step);
    if (key === null) return;
    if (row !== null) {
      choose(key);
      // Its focus moves the list's tab stop with it, and scrolls it into view.
      document.querySelector<HTMLElement>(`[data-inbox-key="${encodeURIComponent(key)}"]`)?.focus();
      return;
    }
    const detail = detailRef.current;
    if (detail !== null && detail.contains(target)) {
      if (key === selectedKey) return;
      // Still waiting in the pane from the last step: where that one was going.
      const pending = pendingFocus.current;
      const into: FocusDestination =
        target === detail &&
        pending !== null &&
        pending.seq === request.seq &&
        pending.key === selectedKey
          ? pending.to
          : target.closest("[data-decision-answer]") !== null
            ? "answer"
            : "words";
      handOff(key, into);
      revealRow(key);
      return;
    }
    if (key !== selectedKey) choose(key);
    revealRow(key);
  };

  // The question shown, said as it changes: by its id while the keyboard is on its row, whose
  // name has just been read, and with its line from anywhere else, once that line or the question
  // itself is read. Not what an opening's list first shows, which the focus on its row says, nor
  // a regroup or a late line, which change nothing shown.
  const announced = useRef<{ seq: number; key: string | null } | null>(null);
  useEffect(() => {
    if (!active || listRead.state !== "listed") return;
    const last = announced.current;
    if (last === null || last.seq !== request.seq) {
      announced.current = { seq: request.seq, key: selectedKey };
      return;
    }
    if (last.key === selectedKey) return;
    // Nothing shown: forgotten, so a question that comes back is said again.
    if (selected === null || selectedKey === null) {
      announced.current = { seq: request.seq, key: null };
      return;
    }
    const focusedRow = document.activeElement?.closest("[data-roving-row]");
    const onRow = focusedRow?.getAttribute("data-inbox-key") === encodeURIComponent(selectedKey);
    const line = lines.get(selectedKey);
    if (!onRow && line === undefined && readResult === null) return;
    announced.current = { seq: request.seq, key: selectedKey };
    const alias = aliasLabel(selected.alias);
    announce(!onRow && line != null ? `Showing ${alias}: ${line}` : `Showing ${alias}`);
  }, [active, listRead.state, selected, selectedKey, request.seq, lines, readResult, announce]);

  // An action that resolved the stall went with it, taking the keyboard along: it
  // waits in the detail, on the question that moved, rather than on nothing.
  useEffect(() => {
    const last = attentionFocus.current;
    if (last === null || last.isConnected) return;
    attentionFocus.current = null;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body && focused.isConnected) return;
    if (!useDecisionsInboxStore.getState().isOpen) return;
    detailRef.current?.focus({ preventScroll: true });
  });

  // A question asked for while open takes the keyboard to its row, as an opening does, and so
  // brings it into view: the row the keyboard was on would keep the list's tab stop otherwise. Only
  // as it's asked for: one listed later is shown without taking the keyboard from where it is. A
  // layer over the inbox (a confirmation, the palette closing) keeps the keyboard it holds; the row
  // is brought into view, and takes the keyboard once the layer hands it back into the inbox soon
  // after (the palette returning it to where it was opened from). Choosing another question, a
  // close or another ask meanwhile drops that.
  const focusedAsk = useRef(ask);
  useEffect(() => {
    if (focusedAsk.current === ask) return;
    focusedAsk.current = ask;
    const list = listRef.current;
    if (!isOpen || !askedShown || selectedKey === null || list === null) return;
    const rowSelector = `[data-inbox-key="${encodeURIComponent(selectedKey)}"]`;
    const row = list.querySelector<HTMLElement>(rowSelector);
    if (row === null) return;
    const active = document.activeElement;
    const surface = list.closest('[role="dialog"]');
    if (
      surface === null ||
      active === null ||
      active === document.body ||
      surface.contains(active)
    ) {
      row.focus();
      return;
    }
    row.scrollIntoView({ block: "nearest" });
    let handOn: ReturnType<typeof setTimeout> | undefined;
    const onFocusIn = (event: FocusEvent) => {
      const landed = event.target;
      if (!(landed instanceof Node) || !surface.contains(landed)) return;
      stop();
      // After the focus that landed has run its own handlers, so the list records the move, and
      // only while it's still there.
      handOn = setTimeout(() => {
        if (document.activeElement === landed)
          list.querySelector<HTMLElement>(rowSelector)?.focus();
      }, 0);
    };
    const expiry = setTimeout(() => stop(), LAYER_HANDBACK_MS);
    function stop() {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("pointerdown", stop, true);
      clearTimeout(expiry);
    }
    document.addEventListener("focusin", onFocusIn, true);
    // A press anywhere is the person taking over: the keyboard stays where it lands.
    document.addEventListener("pointerdown", stop, true);
    return () => {
      stop();
      clearTimeout(handOn);
    };
  }, [ask, isOpen, askedShown, selectedKey]);

  // Each question is read from its top, wherever the last one was scrolled to.
  useLayoutEffect(() => {
    if (detailRef.current !== null) detailRef.current.scrollTop = 0;
  }, [selectedKey]);

  // Except one waiting on a reply, which opens at the agent's request for it (#18040): once per
  // choice, so a read again or a request that comes while it's being read leaves it where it is.
  // A read already on screen can predate the request: without it there, a read made for this
  // choice opens, once, at the request it holds itself, else at the thread, until one holds it.
  const replyScroll = useRef<{
    seq: number;
    key: string;
    messageId: string | null;
    stale: TaggedRead | null;
    interim: boolean;
  } | null>(null);
  const replyId = selected === null ? null : replyToShow(selected);
  const { shownRead: taggedRead } = reader;
  useEffect(() => {
    if (!isOpen || selectedKey === null) {
      replyScroll.current = null;
      return;
    }
    let pending = replyScroll.current;
    if (pending === null || pending.seq !== request.seq || pending.key !== selectedKey) {
      pending = {
        seq: request.seq,
        key: selectedKey,
        messageId: replyId,
        stale: taggedRead,
        interim: false,
      };
      replyScroll.current = pending;
    } else if (pending.messageId !== null && pending.messageId !== replyId) {
      // Superseded, or answered, before it was scrolled to: the newest request, or none.
      pending = { ...pending, messageId: replyId };
      replyScroll.current = pending;
    }
    const { messageId } = pending;
    const read = taggedRead?.read;
    if (messageId === null || read?.result !== "read") return;
    const detail = detailRef.current;
    const entryOf = (id: string) =>
      detail?.querySelector(`[data-message-id="${CSS.escape(id)}"]`) ?? null;
    // What the read itself shows still waiting: the list can lag it either way.
    const own = replyRequest(read.question)?.messageId ?? null;
    const entry = entryOf(messageId);
    if (entry !== null) {
      replyScroll.current = { ...pending, messageId: null, stale: null };
      // Replied to in the read already, it no longer waits, so it stays at its top.
      (own === messageId ? entry : own === null ? null : entryOf(own))?.scrollIntoView({
        block: "nearest",
      });
      return;
    }
    if (taggedRead === pending.stale || pending.interim) return;
    replyScroll.current = { ...pending, interim: true };
    (
      (own === null ? null : entryOf(own)) ??
      detail?.querySelector('[data-testid="decision-question-thread"]')
    )?.scrollIntoView({
      block: "nearest",
    });
  }, [isOpen, request.seq, selectedKey, replyId, taggedRead]);

  // Where the person went from this opening: the close hands focus to the
  // terminal, and nothing of it outlives the opening it was asked in.
  const [handoff, setHandoff] = useState<{
    seq: number;
    terminalId: string;
    projectId: string;
    reach: "here" | "elsewhere";
  } | null>(null);
  const going = handoff !== null && handoff.seq === request.seq ? handoff : null;

  const restoreFocusTo = useCallback((): HTMLElement | null => {
    const terminalId = request.terminalId;
    if (terminalId === null) return null;
    const escaped = CSS.escape(terminalId);
    const pane =
      document.querySelector<HTMLElement>(
        `[data-panel-id="${escaped}"][data-panel-location="grid"]`
      ) ?? document.querySelector<HTMLElement>(`[data-panel-id="${escaped}"]`);
    return pane?.querySelector<HTMLElement>(PANE_CHIP) ?? pane;
  }, [request.terminalId]);

  // Only while this opening is the one on screen: its button stays focusable through the exit.
  const stillShowing = (seq: number): boolean => {
    const state = useDecisionsInboxStore.getState();
    return state.isOpen && state.request.seq === seq;
  };

  const goToTerminal = () => {
    if (selected === null || reach === null) return;
    const { terminalId, projectId } = selected.reference;
    const seq = request.seq;
    if (!stillShowing(seq)) return;
    if (reach === "here") {
      setHandoff({ seq, terminalId, projectId, reach });
      close();
      return;
    }
    // Looked for again first: it may have closed since the last look.
    const attempt = ++navigation.current;
    const shownKey = referenceKey(selected.reference);
    const settle = (open: boolean) => {
      if (attempt !== navigation.current || !stillShowing(seq)) return;
      if (!open) {
        markGone(shownKey);
        return;
      }
      setHandoff({ seq, terminalId, projectId, reach });
      close();
    };
    runsTerminal(terminalId, projectId).then(settle, () => settle(false));
  };

  const onCloseComplete = (restoreSkipped?: () => void) => {
    // Content is never kept past the close.
    reader.release();
    attention.release();
    releaseLines();
    releaseReplyLines();
    releaseList();
    setHandoff(null);
    if (going === null) return;
    const landed =
      going.reach === "here"
        ? actionService.dispatch("panel.focus", { panelId: going.terminalId })
        : actionService.dispatch("pilot.openRun", {
            runId: going.terminalId,
            workspaceId: going.projectId,
          });
    // A terminal that went in the meantime leaves focus where the inbox found it.
    void landed.then(
      (result) => {
        if (!result.ok) restoreSkipped?.();
      },
      () => restoreSkipped?.()
    );
  };

  const showListSkeleton = useSkeletonGate(active && listRead.state === "loading");
  const listReach: InboxReach = !statusKnown
    ? "pending"
    : status === null
      ? "unknown"
      : status.problem === "storage"
        ? "unreadable"
        : notice !== null
          ? "unavailable"
          : "connected";
  const listed = listRead.state === "listed";
  const hostsAway = listRead.state === "listed" ? (listRead.list.hostsAway ?? []) : [];
  // Only once the relay, and every Remote Host, is known to be reachable does an empty list say
  // nothing was asked; narrowed to this project, the line above the list says it has none.
  const empty =
    listed && scope === "all" && listReach === "connected" && hostsAway.length === 0
      ? emptyText(groups)
      : null;
  const waitingLine =
    listed && empty === null ? waitingText(groups, listReach, hostsAway, scope) : null;

  return (
    <>
      <AppDialog
        isOpen={isOpen}
        onClose={close}
        size="7xl"
        maxHeight="max-h-[min(52rem,88vh)]"
        className="h-[min(52rem,88vh)]"
        // The surface while the list loads, so Enter can't land on Close; then
        // the selected row, or Retry when the list couldn't be read.
        initialFocus={listRead.state === "loading" ? "surface" : "first"}
        focusResetKey={`${request.seq}:${listRead.state}`}
        restoreFocusTo={restoreFocusTo}
        // Going to a panel of this view, the close leaves focus for the panel to take.
        restoreFocusOnClose={going?.reach !== "here"}
        onCloseComplete={onCloseComplete}
        onKeyDownCapture={onStepKeyDownCapture}
        data-testid="decisions-inbox-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title icon={<DecisionsIcon size={16} />}>Decisions inbox</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        {notice !== null && (
          // Above both columns, so what it says about sending stays in view of the composer.
          <div className="shrink-0 px-4 pt-3">
            <Callout
              severity={notice.severity}
              size="compact"
              data-testid="decisions-inbox-connection"
            >
              {notice.text}
            </Callout>
          </div>
        )}
        {/* Two columns that scroll on their own, so a plain element rather than the dialog's body
            column. With no question ever asked, the list spans both and says so; it stays the same
            element throughout, so the keyboard on it stays as the canvas comes and goes. */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            className={cn(
              "flex flex-col",
              empty !== null
                ? "min-w-0 flex-1"
                : "w-80 shrink-0 border-r border-divider lg:w-[26rem]"
            )}
          >
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain",
                // The sidebar colour belongs to the list beside a question, not the canvas.
                empty === null && "decisions-inbox-list"
              )}
              data-testid="decisions-inbox-list"
            >
              {listRead.state === "loading" && showListSkeleton && <ListSkeleton />}
              {listRead.state === "failed" && (
                <div className="p-3">
                  <Callout
                    severity="warning"
                    size="compact"
                    action={
                      <Button variant="outline" size="xs" onClick={retry}>
                        Retry
                      </Button>
                    }
                    data-testid="decisions-inbox-failed"
                  >
                    The questions couldn&apos;t be read.
                  </Callout>
                </div>
              )}
              {listed && (
                <InboxList
                  listRef={listRef}
                  lead={
                    empty !== null ? (
                      <div
                        className="flex min-h-0 flex-1 items-center justify-center p-8"
                        data-testid="decisions-inbox-empty"
                      >
                        <EmptyState
                          variant="zero-data"
                          scale="canvas"
                          icon={<DecisionsIcon />}
                          title="No questions yet"
                          description={empty}
                        />
                      </div>
                    ) : waitingLine !== null ? (
                      <p
                        className="px-3 py-2.5 text-xs leading-4 text-text-secondary [text-wrap:pretty]"
                        data-testid="decisions-inbox-waiting"
                      >
                        {waitingLine}
                      </p>
                    ) : null
                  }
                  groups={groups}
                  open={openGroups}
                  onFold={(id, open) => fold(id, open, true)}
                  lines={lines}
                  replyLines={replyLines}
                  partsOf={partsOf}
                  nowMs={nowMs}
                  selectedKey={selectedKey}
                  onSelect={(key) => {
                    // A dwell that ends as the inbox closes changes nothing shown.
                    if (stillShowing(request.seq)) {
                      setChoice({
                        seq: request.seq,
                        scope,
                        ask,
                        key,
                        index: drawnIndexOf(key),
                        picked: true,
                      });
                    }
                  }}
                  onAnswer={(key) => handOff(key, "answer")}
                />
              )}
            </div>
            {/* Below the list rather than on its heading, so the dialog's first focus stays on the
                question list. Clear only while Needs you has questions: the press that empties it
                hands the keyboard to the list. It clears what the list shows, and says how far. */}
            {(showScope || waiting.length > 0) && (
              <div className="decisions-inbox-list-footer flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-divider px-3 py-2">
                {showScope && (
                  <SegmentedRadioGroup<InboxScope>
                    density="compact"
                    aria-label="Questions shown"
                    testId="decisions-inbox-scope"
                    value={scope}
                    onChange={(next) => setScopeChoice({ seq: request.seq, scope: next })}
                    options={SCOPE_OPTIONS}
                  />
                )}
                {/* Only while Needs you holds an ask with no agent: the press that clears them hands
                    the keyboard to the list, as clearing Needs you does. */}
                {gone.length > 0 && (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          ref={handBackToList}
                          variant="ghost"
                          size="xs"
                          aria-describedby={clearGoneHintId}
                          onClick={() => markShown("clear", gone)}
                          className="ml-auto"
                          data-testid="decisions-inbox-clear-gone"
                        >
                          {clearGoneText(gone.length)}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{CLEAR_GONE_HINT}</TooltipContent>
                    </Tooltip>
                    <span id={clearGoneHintId} className="sr-only">
                      {CLEAR_GONE_HINT}
                    </span>
                  </>
                )}
                {waiting.length > 0 && (
                  <Button
                    ref={handBackToList}
                    variant="ghost"
                    size="xs"
                    onClick={() => markShown("clear", waiting)}
                    className={gone.length > 0 ? undefined : "ml-auto"}
                    data-testid="decisions-inbox-clear-all"
                  >
                    {clearAllText(scope, clearNamesReach)}
                  </Button>
                )}
              </div>
            )}
          </div>
          {empty === null && (
            <section
              ref={detailRef}
              // A stop of its own, so a question with nothing to press still scrolls from the keyboard.
              tabIndex={selected !== null ? 0 : -1}
              // A hand-off waits only while the keyboard waits here with it.
              onBlur={(event) => {
                if (event.target === event.currentTarget) pendingFocus.current = null;
              }}
              aria-labelledby={selected !== null ? detailHeadingId : undefined}
              aria-label={selected === null ? "Question details" : undefined}
              // Room for the sticky bar, so whatever is scrolled to opens below it rather than under it.
              className="flex min-w-0 flex-1 scroll-pt-16 flex-col overflow-y-auto overscroll-contain outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
              data-testid="decisions-inbox-detail"
            >
              {/* Nothing opened by itself (#18022): a quiet word in the pane, never a blank one. */}
              {selected === null && listRead.state !== "loading" && (
                <div
                  className="flex flex-1 items-center justify-center p-8"
                  data-testid="decisions-inbox-detail-empty"
                >
                  <EmptyState
                    variant="zero-data"
                    scale="sidebar"
                    title={
                      ordered.length > 0
                        ? "Choose a question to read it"
                        : "Question details appear here"
                    }
                  />
                </div>
              )}
              {selected !== null && (
                <>
                  {/* The pane's bar, as Canopy's: who asked and where, and what can be done to it. */}
                  <div className="sticky top-0 z-1 shrink-0 border-b border-divider bg-surface-dialog">
                    {/* On the body's measure, so the bar's actions end where the question does. */}
                    <div className="flex min-h-12 w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-8 py-2">
                      <h3
                        id={detailHeadingId}
                        className="sr-only"
                        data-testid="decisions-inbox-detail-title"
                      >
                        Question {aliasLabel(selected.alias)}
                      </h3>
                      {/* The pane that asked and where, as the Decisions app's bar names it; who asked heads the question. */}
                      <p className="flex min-w-0 flex-1 items-center gap-2 text-xs text-text-secondary">
                        <span
                          className="min-w-0 truncate"
                          data-testid="decisions-inbox-detail-origin"
                        >
                          <FactRun facts={headerFacts(partsOf(selected))} />
                        </span>
                        <span className="shrink-0 font-mono text-2xs tabular-nums">
                          {aliasLabel(selected.alias)}
                        </span>
                      </p>
                      {/* Ghost buttons pad their ink; pulled out by that pad so the text ends where the body does. */}
                      <div className="-mr-2 flex shrink-0 items-center gap-1">
                        {reach !== null && (
                          <DescribedAction
                            description={GO_TO_TERMINAL_TEXT}
                            variant="ghost"
                            size="xs"
                            onClick={goToTerminal}
                            data-testid="decisions-inbox-go-to-terminal"
                          >
                            Go to terminal
                          </DescribedAction>
                        )}
                        {/* One button that turns into its inverse, so the keyboard stays on it as the
                            question moves between groups. Needs only the list: it works whether or
                            not the question can be read or its terminal reached. */}
                        {/* Kept, unavailable, once its deadline passes under it, so focus on it stays. */}
                        {(selectedGroup === "needs-you" ||
                          selectedGroup === "cleared" ||
                          selectedGroup === "awaiting") && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="xs"
                                aria-disabled={
                                  clearWaits || selectedGroup === "awaiting" || undefined
                                }
                                aria-describedby={clearHintId}
                                onClick={() => {
                                  if (clearWaits || selectedGroup === "awaiting") return;
                                  markShown(selectedGroup === "cleared" ? "restore" : "clear", [
                                    selected,
                                  ]);
                                }}
                                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                                data-testid="decisions-inbox-clear"
                              >
                                {selectedGroup === "cleared"
                                  ? "Restore to Needs you"
                                  : "Clear from Needs you"}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{clearHint}</TooltipContent>
                          </Tooltip>
                        )}
                        {/* What Clear does, before it's pressed (#17943): it stays local and declines nothing. */}
                        <span id={clearHintId} className="sr-only">
                          {clearHint}
                        </span>
                        {reader.cancellable &&
                          (dismissal.progress !== null ? (
                            dismissal.phase?.kind === "lost" && (
                              <DescribedAction
                                ref={cancelRef}
                                description={RETRY_DECLINE_TEXT}
                                variant="outline"
                                size="xs"
                                onClick={dismissal.retry}
                                data-testid="decisions-inbox-dismiss-retry"
                              >
                                Retry
                              </DescribedAction>
                            )
                          ) : dismissal.fallback !== null ? (
                            <DescribedAction
                              ref={cancelRef}
                              description={WITHDRAW_TEXT}
                              variant="ghost-danger"
                              size="xs"
                              onClick={cancel.askToWithdraw}
                              data-testid="decisions-inbox-withdraw"
                            >
                              Withdraw question
                            </DescribedAction>
                          ) : (
                            // Danger, as in the question view: unlike Clear, it's sent and can't be undone.
                            <DescribedAction
                              ref={cancelRef}
                              description={DECLINE_TEXT}
                              variant="ghost-danger"
                              size="xs"
                              onClick={cancel.ask}
                              data-testid="decisions-inbox-dismiss"
                            >
                              Decline question
                            </DescribedAction>
                          ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex w-full max-w-3xl flex-col gap-4 px-8 py-6">
                    {reader.cancellable && dismissNote !== null && (
                      <p
                        role={dismissNote.live ? "status" : undefined}
                        className="text-xs text-text-secondary [text-wrap:pretty]"
                        data-testid="decisions-inbox-dismiss-status"
                      >
                        {dismissNote.text}
                      </p>
                    )}
                    {selectedAsker !== null && (
                      <Callout
                        severity="neutral"
                        size="compact"
                        data-testid="decisions-inbox-asker"
                      >
                        {selectedAsker.detail}
                      </Callout>
                    )}
                    {selected.standing.kind === "needs-attention" && (
                      <div
                        className="flex flex-col gap-2"
                        // Its actions and its Retry alike, so whichever goes leaves the keyboard here.
                        onFocus={(event) => {
                          attentionFocus.current = event.target;
                        }}
                      >
                        <Callout
                          severity="warning"
                          size="compact"
                          title={
                            selected.standing.deliveryStatus === "delivery-uncertain"
                              ? "Delivery uncertain"
                              : "Delivery stopped"
                          }
                          action={
                            // This computer's stall is resolved below; a Remote Host's, as it offers it.
                            selected.remoteHost === undefined ? undefined : (
                              <HostAttentionActions
                                attention={hostAttention}
                                fallbackFocus={detailRef}
                              />
                            )
                          }
                          data-testid="decisions-inbox-attention"
                        >
                          {attentionText(selected)}
                        </Callout>
                        {attentionItem !== null && (
                          <div
                            ref={attentionActionsRef}
                            data-testid="decisions-inbox-attention-actions"
                          >
                            <AttentionActionRow
                              item={attentionItem}
                              worktreeName={attentionWorktreeName}
                              busy={attentionBusy}
                              onResume={() => attentionActions.resume(attentionItem)}
                              onChoose={(destination) =>
                                attentionActions.choose(attentionItem, destination)
                              }
                              onHandled={() => attentionActions.handle(attentionItem)}
                              held={attention.stale}
                            />
                          </div>
                        )}
                        {attention.read.state === "not-running" && (
                          <p className="text-xs text-text-secondary [text-wrap:pretty]">
                            Decisions isn&apos;t delivering answers on this computer right now, so
                            this one can&apos;t be resolved here.
                          </p>
                        )}
                        {attention.read.state === "failed" && (
                          <Callout
                            severity="warning"
                            size="compact"
                            action={
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() => void attention.refresh()}
                              >
                                Retry
                              </Button>
                            }
                            data-testid="decisions-inbox-attention-failed"
                          >
                            {attention.read.message}
                          </Callout>
                        )}
                      </div>
                    )}
                    {/* Kept apart from the stall, so a resume that moves the question while it
                        runs, and what came of it, stay in view as it changes group. */}
                    <ResumePending
                      key={selected.reference.questionId}
                      alias={selected.alias}
                      active={attentionBusy === "resume"}
                    />
                    {attentionOutcome !== null && !outcomeSuperseded && (
                      <Callout
                        severity={attentionOutcome.severity}
                        size="compact"
                        data-testid="decisions-inbox-attention-outcome"
                      >
                        {attentionOutcome.message}
                      </Callout>
                    )}
                    <HostAttentionStatus attention={hostAttention} fallbackFocus={detailRef} />
                    {/* Collapsed and unread until asked for (#18037); each question and opening starts afresh. */}
                    <DecisionAskingPane
                      key={`${request.seq}:${selectedKey}`}
                      reference={selected.reference}
                    />
                    <DecisionQuestionReadView
                      reader={reader}
                      target={shownTarget}
                      active={isOpen}
                      headingId={questionHeadingId}
                      // As the question view does, so a reply in progress never unmounts as it moves on.
                      followUps
                      // So the follow-up waits on the same stall the warning above names.
                      listed={selected}
                      // The warning says how far the closing notice got; the facts needn't again.
                      noticeShown={attentionNotice(selected)}
                      eyebrow={
                        <p className="flex items-center gap-1.5 text-xs">
                          <span
                            className="flex size-4 items-center justify-center"
                            aria-hidden="true"
                          >
                            <AgentMark agentKind={selected.agentKind} />
                          </span>
                          <span className="font-medium text-text-primary">
                            {partsOf(selected).agent}
                          </span>
                        </p>
                      }
                      deliveryNotice={selectedAsker?.composer ?? null}
                      sendNote={
                        // Only while a connection is being retried, never past a problem that needs the person.
                        status !== null &&
                        status.problem === undefined &&
                        (status.state === "connecting" ||
                          status.state === "reconnecting" ||
                          status.state === "replaced")
                          ? "Sends once reconnected"
                          : null
                      }
                    />
                    {/* Once this one is settled, the way on sits where the reading ends. */}
                    {nextUp !== null && (
                      <div className="-mr-2 flex justify-end">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={showNext}
                          data-testid="decisions-inbox-next"
                        >
                          Next question
                          <ArrowRight className="size-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </section>
          )}
        </div>
        {/* After the columns, so the dialog's first focus still lands on the question list. Each
            opening has its own, so nothing a save in an earlier one settles reaches this one. */}
        <DecisionsInvolvementSection
          key={request.seq}
          active={active}
          opening={request.seq}
          statusRevision={status?.revision ?? null}
        />
      </AppDialog>
      <DecisionCancelDialog
        {...cancel.dialog}
        // The button goes once the question stops waiting; the detail then takes focus.
        restoreFocusTo={() =>
          cancelRef.current?.isConnected ? cancelRef.current : detailRef.current
        }
      />
      <AttentionConfirmations
        actions={attentionActions}
        worktreeName={attentionWorktreeName}
        restoreFocusOnClose={isOpen}
        // The detail's question is a read of its own: the confirmation names what this item holds.
        showSubject
        // Back to an action of the stall's that can take it; once a fast action has
        // resolved the stall and its actions went with it, to the detail.
        restoreFocusTo={() =>
          attentionActionsRef.current?.querySelector<HTMLElement>(
            `${ATTENTION_ACTIONS}:not(:disabled)`
          ) ?? detailRef.current
        }
      />
    </>
  );
}
