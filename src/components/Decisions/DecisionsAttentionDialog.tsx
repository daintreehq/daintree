import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RotateCw } from "lucide-react";
import { DecisionsIcon, TriangleAlert } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { decisionsClient } from "@/clients/decisionsClient";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";
import { worktreeDisplayName } from "@/utils/recipeScope";
import { pluralize } from "@/lib/pluralize";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { WorktreeSnapshot } from "@shared/types";
import type { DecisionQuestionList } from "@shared/types/decisionsQuestion";
import type {
  DecisionsAnswerDestination,
  DecisionsAnswerDestinations,
  DecisionsAnswerOutcome,
  DecisionsAttentionItem,
  DecisionsAttentionList,
  DecisionsFollowUpPreview,
  DecisionsTimeoutNotice,
} from "@shared/types/decisionsAttention";
import {
  ELSEWHERE_HEADING,
  EMPTY_DESCRIPTION,
  LIST_DESCRIPTION,
  NONE_FOR_PANE,
  PLAN_CAPTION,
  RESUME_PENDING,
  STILL_WORKING,
  agentLabel,
  aliasLabel,
  attentionFingerprint,
  canCopy,
  canOpenQuestion,
  copyLabel,
  destinationGroups,
  destinationRowDetail,
  fromLines,
  groupForPane,
  handledConfirmBody,
  handledConfirmTitle,
  handledNeedsConfirm,
  hasFullerQuestion,
  leavesList,
  missingAnswerText,
  moveConfirmBody,
  noticeDeliveryText,
  noticeOutcomeText,
  noticePlanText,
  originParts,
  outcomeSeverity,
  outcomeText,
  paneName,
  reasonText,
  remainingText,
  sameAttention,
  statusText,
  subjectOf,
  toLines,
  type PaneLines,
} from "./decisionsAttentionModel";

type Busy = "resume" | "reassign" | "handled";

interface PendingMove {
  item: DecisionsAttentionItem;
  destination: DecisionsAnswerDestination;
}

interface Outcome {
  message: string;
  severity: "success" | "warning";
}

/** A question's actions, so focus can land on the next one when its item leaves. */
const ITEM_ACTIONS = "[data-attention-action]";

/** A pane's Decisions chip, where the close returns when the list was opened from it. */
const PANE_CHIP = '[data-testid="terminal-decisions-chip"]';

/** Pushes for panes arrive in bursts; one read after they settle. */
const REFRESH_DEBOUNCE_MS = 300;

/** Past this, a resume's wait says it is still going. */
const STILL_WORKING_MS = 5_000;

type WorktreeName = (id: string, fallback: string | null) => string | null;

const NO_WORKTREES = new Map<string, WorktreeSnapshot>();

/**
 * The project's own names for its worktrees, where the list opens in a project
 * view. The Canopy window holds no project: there each answer keeps the name
 * it was asked under.
 */
function useWorktreeNames(): WorktreeName {
  const worktreeMap = useWorktreeStoreOptional((state) => state.worktrees, NO_WORKTREES);
  return useCallback(
    (id: string, fallback: string | null) => {
      const known = worktreeMap.get(id);
      return worktreeDisplayName(known) ?? fallback;
    },
    [worktreeMap]
  );
}

/** True once `active` has held for `ms`; false again as soon as it ends. */
function useHeldFor(active: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return held;
}

/**
 * Whether a folded quote's text runs past its clamp, measured again as the
 * text changes, as it folds back, and as the dialog's width changes.
 */
function useClamped(text: string | null | undefined, expanded: boolean) {
  const textRef = useRef<HTMLQuoteElement>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el === null || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);
  return { textRef, clamped };
}

/** The answer as the phone sent it; a long one opens in place rather than being cut for good. */
function AnswerPreview({ item }: { item: DecisionsAttentionItem }) {
  const { answer } = item;
  const alias = aliasLabel(item.alias);
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  const { textRef, clamped } = useClamped(answer?.text, expanded);

  if (answer === null) {
    // Only follow-ups need a person: the answer was typed in.
    if (item.answerUnavailable === null) return null;
    return (
      <p className="text-xs text-text-secondary [text-wrap:pretty]">
        {missingAnswerText(item.answerUnavailable)}
      </p>
    );
  }
  const source = answer.source === "proxy" ? "Decision model's answer" : "Your answer";
  return (
    <figure className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2">
      <figcaption className="text-2xs text-text-secondary">
        {source}
        {answer.correction && ", correcting an earlier one"} <FactSeparator />{" "}
        <TimeAgo timestamp={answer.answeredAt} />
      </figcaption>
      {answer.choices.length > 0 && (
        <p className="text-xs font-semibold text-text-primary [text-wrap:pretty]">
          {answer.choices.join(", ")}
        </p>
      )}
      {answer.text !== null && (
        <blockquote
          ref={textRef}
          id={textId}
          className={
            expanded
              ? "whitespace-pre-wrap break-words text-xs text-text-primary [text-wrap:pretty]"
              : "line-clamp-4 whitespace-pre-wrap break-words text-xs text-text-primary [text-wrap:pretty]"
          }
        >
          {answer.text}
        </blockquote>
      )}
      {(clamped || expanded) && (
        <Button
          variant="link"
          size="xs"
          className="self-start px-0"
          aria-expanded={expanded}
          aria-controls={textId}
          aria-label={expanded ? `Show less for ${alias}` : `Show full answer for ${alias}`}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show full answer"}
        </Button>
      )}
    </figure>
  );
}

/**
 * The notice that the question's deadline closed it (#17944): how the question
 * ended, and what typing the notice says of the agent's plan, apart from the
 * status line above, which says how far typing it got.
 */
function NoticePreview({ notice }: { notice: DecisionsTimeoutNotice }) {
  const plan = noticePlanText(notice);
  return (
    <figure className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2">
      <figcaption className="text-2xs text-text-secondary">
        Timeout notice, {noticeDeliveryText(notice)}
        {notice.deadline !== null && (
          <>
            {" "}
            <FactSeparator /> <TimeAgo timestamp={notice.deadline} prefix="deadline " />
          </>
        )}
      </figcaption>
      <p className="text-xs text-text-primary [text-wrap:pretty]">{noticeOutcomeText(notice)}</p>
      {plan !== null && <p className="text-xs text-text-secondary [text-wrap:pretty]">{plan}</p>}
    </figure>
  );
}

/**
 * A follow-up the person sent from their phone or computer (#16231), as it would be
 * typed in. It never changes the answer, so it shows apart from it.
 */
function FollowUpPreview({
  followUp,
  alias,
}: {
  followUp: DecisionsFollowUpPreview;
  alias: string;
}) {
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  const { textRef, clamped } = useClamped(followUp.text, expanded);

  return (
    <figure className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2">
      <figcaption className="text-2xs text-text-secondary">
        {followUp.onComputer
          ? "Your follow-up from your computer"
          : "Your follow-up from your phone"}
        {followUp.status === "delivery-uncertain" && ", may or may not have been delivered"}{" "}
        <FactSeparator /> <TimeAgo timestamp={followUp.sentAt} />
      </figcaption>
      {followUp.text !== null ? (
        <blockquote
          ref={textRef}
          id={textId}
          className={
            expanded
              ? "whitespace-pre-wrap break-words text-xs text-text-primary [text-wrap:pretty]"
              : "line-clamp-4 whitespace-pre-wrap break-words text-xs text-text-primary [text-wrap:pretty]"
          }
        >
          {followUp.text}
        </blockquote>
      ) : (
        <p className="text-xs text-text-secondary [text-wrap:pretty]">
          {followUp.unreadable
            ? "This follow-up couldn't be opened on this computer."
            : "This follow-up has no words to type in."}
        </p>
      )}
      {(clamped || expanded) && (
        <Button
          variant="link"
          size="xs"
          className="self-start px-0"
          aria-expanded={expanded}
          aria-controls={textId}
          aria-label={expanded ? `Show less for ${alias}` : `Show full follow-up for ${alias}`}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show full follow-up"}
        </Button>
      )}
    </figure>
  );
}

/**
 * The plan the agent stated for an advisory round (#18055), in its own words,
 * beside the notice that says whether it may go ahead with it. Never that it did.
 */
function PlanPreview({ plan, alias }: { plan: string; alias: string }) {
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  const { textRef, clamped } = useClamped(plan, expanded);
  return (
    <figure
      className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2"
      data-testid="decisions-attention-plan"
    >
      <figcaption className="text-2xs text-text-secondary">{PLAN_CAPTION}</figcaption>
      <blockquote
        ref={textRef}
        id={textId}
        className={
          expanded
            ? "whitespace-pre-wrap break-words text-xs text-text-primary [text-wrap:pretty]"
            : "line-clamp-4 whitespace-pre-wrap break-words text-xs text-text-primary [text-wrap:pretty]"
        }
      >
        {plan}
      </blockquote>
      {(clamped || expanded) && (
        <Button
          variant="link"
          size="xs"
          className="self-start px-0"
          aria-expanded={expanded}
          aria-controls={textId}
          aria-label={expanded ? `Show less for ${alias}` : `Show full plan for ${alias}`}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show full plan"}
        </Button>
      )}
    </figure>
  );
}

/**
 * The rest of the question past the row's heading, read in place (#18055),
 * and the question view for its notes and images where it can open it.
 */
function QuestionDetail({ item }: { item: DecisionsAttentionItem }) {
  const alias = aliasLabel(item.alias);
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  const fuller = hasFullerQuestion(item);
  const { reference } = item;
  const openable = reference !== null && canOpenQuestion(item);
  if (!fuller && !openable) return null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3">
        {fuller && (
          <Button
            variant="link"
            size="xs"
            className="px-0"
            aria-expanded={expanded}
            aria-controls={textId}
            aria-label={
              expanded
                ? `Show less of the question for ${alias}`
                : `Show full question for ${alias}`
            }
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Show less" : "Show full question"}
          </Button>
        )}
        {openable && (
          <Button
            variant="link"
            size="xs"
            className="px-0"
            aria-label={`Open question ${alias}`}
            // Over this list, so closing it comes back to the decision.
            onClick={() =>
              useDecisionsQuestionViewStore.getState().openReference([reference], reference)
            }
          >
            Open question
          </Button>
        )}
      </div>
      {fuller && (
        <p
          id={textId}
          hidden={!expanded}
          className="whitespace-pre-wrap break-words text-xs text-text-primary [text-wrap:pretty]"
          data-testid="decisions-attention-question"
        >
          {item.fullQuestion}
        </p>
      )}
    </>
  );
}

interface ItemProps {
  item: DecisionsAttentionItem;
  /** Opens the rest of the list below the opening pane's items. */
  heading?: string;
  /** One of the opening pane's own items, where an opening for it lands. */
  forPane: boolean;
  worktreeName: WorktreeName;
  busy: Busy | null;
  onResume: () => void;
  onChoose: (destination: DecisionsAnswerDestination) => void;
  onHandled: () => void;
}

function AttentionItem({
  item,
  heading,
  forPane,
  worktreeName,
  busy,
  onResume,
  onChoose,
  onHandled,
}: ItemProps) {
  const headingId = useId();
  const groupIdBase = useId();
  const alias = aliasLabel(item.alias);
  const { pane, place } = originParts(
    item,
    worktreeName(item.origin.worktreeId, item.origin.worktreeName)
  );
  const reason = reasonText(item.reason, subjectOf(item));
  const [destinations, setDestinations] = useState<DecisionsAnswerDestinations | null>(null);
  const [destinationsError, setDestinationsError] = useState<string | null>(null);
  const locked = busy !== null;
  const stillWorking = useHeldFor(busy === "resume", STILL_WORKING_MS);
  const announce = useAnnouncerStore((state) => state.announce);
  // The wait's reassurance reaches a screen reader too, once, outside the busy item.
  useEffect(() => {
    if (stillWorking) announce(`${alias}: ${STILL_WORKING}`);
  }, [stillWorking, alias, announce]);

  // Every opening and closing starts a new generation, so a lookup from an opening already
  // closed can't overwrite the agents (or the error) of the menu showing now.
  const destinationsGenerationRef = useRef(0);
  const loadDestinations = (open: boolean) => {
    const generation = ++destinationsGenerationRef.current;
    if (!open) return;
    setDestinations(null);
    setDestinationsError(null);
    decisionsClient.listAnswerDestinations(item.questionId).then(
      (listed) => {
        if (generation === destinationsGenerationRef.current) setDestinations(listed);
      },
      (error) => {
        if (generation !== destinationsGenerationRef.current) return;
        setDestinationsError(formatErrorMessage(error, "Couldn't list the running agents"));
      }
    );
  };

  return (
    <li
      className={
        heading === undefined ? "flex flex-col gap-2 py-4" : "flex flex-col gap-2 pt-5 pb-4"
      }
      aria-labelledby={headingId}
      aria-busy={locked || undefined}
      data-question-id={item.questionId}
      data-for-pane={forPane ? "" : undefined}
      data-testid="decisions-attention-item"
    >
      {/* Inside the row, so every child of the list stays a question. */}
      {heading !== undefined && (
        <h3 className="pb-1 text-xs font-medium text-text-secondary">{heading}</h3>
      )}
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-xs text-text-secondary tabular-nums">{alias}</span>
        <h3
          id={headingId}
          className={
            item.question !== null
              ? "min-w-0 flex-1 text-sm font-medium text-text-primary [text-wrap:pretty]"
              : "min-w-0 flex-1 text-sm text-text-secondary [text-wrap:pretty]"
          }
        >
          {item.question ?? "Question couldn't be opened"}
        </h3>
        <TimeAgo
          timestamp={item.askedAt}
          prefix="asked "
          className="shrink-0 text-xs text-text-secondary"
        />
      </div>
      {/* What stopped and why leads, under the question it stopped for. */}
      <p className="flex items-start gap-1.5 text-xs text-text-primary [text-wrap:pretty]">
        <TriangleAlert className="mt-0.5 size-3 shrink-0 text-status-warning" aria-hidden="true" />
        <span>
          <span className="font-medium">{statusText(item)}.</span>
          {reason !== null && ` ${reason}`}
        </span>
      </p>
      <p className="text-xs text-text-secondary [text-wrap:pretty]">
        {pane}
        {place !== null && (
          <>
            {" "}
            <FactSeparator /> {place}
          </>
        )}
      </p>
      <QuestionDetail item={item} />
      {item.notice !== null && <NoticePreview notice={item.notice} />}
      {item.plan !== null && <PlanPreview plan={item.plan} alias={alias} />}
      <AnswerPreview item={item} />
      {item.followUps.map((followUp) => (
        <FollowUpPreview key={followUp.messageId} followUp={followUp} alias={alias} />
      ))}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {item.canResume && (
          <Button
            variant="outline"
            size="xs"
            aria-label={`Try resume for ${alias}`}
            aria-busy={busy === "resume" || undefined}
            aria-disabled={busy === "resume" || undefined}
            data-attention-action=""
            disabled={locked && busy !== "resume"}
            // Busy keeps its focus and its width: the glyph turns while it runs.
            onClick={busy === "resume" ? undefined : onResume}
          >
            {/* Resuming restarts the session that asked: the restart glyph, turning while it runs. */}
            <SpinningIcon icon={RotateCw} active={busy === "resume"} aria-hidden="true" />
            Try resume
          </Button>
        )}
        {item.canReassign && (
          <DropdownMenu onOpenChange={loadDestinations}>
            <DropdownMenuTrigger asChild>
              <Button
                variant={item.canResume ? "ghost" : "outline"}
                size="xs"
                aria-label={`Choose destination for ${alias}`}
                className="data-[state=open]:bg-overlay-soft"
                data-attention-action=""
                loading={busy === "reassign"}
                disabled={locked && busy !== "reassign"}
              >
                Choose destination
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              {destinations === null && destinationsError === null && (
                <DropdownMenuItem disabled>Looking…</DropdownMenuItem>
              )}
              {destinationsError !== null && (
                <DropdownMenuItem disabled>{destinationsError}</DropdownMenuItem>
              )}
              {destinations !== null && destinations.result !== "listed" && (
                <DropdownMenuItem disabled>
                  {destinations.result === "not-running"
                    ? "Decisions isn't running"
                    : "This answer can't be moved now"}
                </DropdownMenuItem>
              )}
              {destinations?.result === "listed" && destinations.destinations.length === 0 && (
                <DropdownMenuItem disabled>No agents are running here</DropdownMenuItem>
              )}
              {destinations?.result === "listed" &&
                destinationGroups(destinations.destinations, item.origin.projectId).map(
                  (group, index) => (
                    <DropdownMenuGroup
                      key={group.projectId}
                      aria-labelledby={`${groupIdBase}-${index}`}
                    >
                      {index > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel id={`${groupIdBase}-${index}`}>
                        {group.label}
                      </DropdownMenuLabel>
                      {group.destinations.map((destination) => (
                        <DropdownMenuItem
                          key={destination.terminalId}
                          focusHandoff
                          onSelect={() => onChoose(destination)}
                          className="flex-col items-start gap-0.5"
                        >
                          <span className="flex w-full items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-text-primary">
                              {destination.title}
                            </span>
                            {destination.askedHere && (
                              <span className="shrink-0 text-2xs text-text-secondary">
                                asked here
                              </span>
                            )}
                          </span>
                          <span className="w-full truncate text-2xs text-text-secondary">
                            {destinationRowDetail(
                              destination,
                              worktreeName(destination.worktreeId, destination.worktreeName)
                            )}
                            {/* The section label shows the project; a row heard alone still names it. */}
                            {destination.projectName !== null && (
                              <span className="sr-only">{` · ${destination.projectName}`}</span>
                            )}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  )
                )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {canCopy(item) && (
          <CopyButton
            label={copyLabel(item)}
            aria-label={`${copyLabel(item)} to ${alias}`}
            variant={item.canResume || item.canReassign ? "ghost" : "outline"}
            size="xs"
            data-attention-action=""
            disabled={locked}
            text={() => decisionsClient.copyAnswer(item.questionId)}
          />
        )}
        {/* Pulled out by its own padding, so its words end on the column's edge. */}
        <Button
          variant="ghost"
          size="xs"
          className="-mr-2.5 ml-auto"
          aria-label={`Mark ${alias} handled`}
          data-attention-action=""
          loading={busy === "handled"}
          disabled={locked && busy !== "handled"}
          onClick={onHandled}
        >
          Mark handled
        </Button>
      </div>
      {busy === "resume" && (
        <p className="text-xs text-text-secondary [text-wrap:pretty]">
          {stillWorking ? `${RESUME_PENDING} ${STILL_WORKING}` : RESUME_PENDING}
        </p>
      )}
    </li>
  );
}

/** A pane in the move confirmation: what it's called, then its agent and place. */
function PaneLinesValue({ lines }: { lines: PaneLines }) {
  return (
    <dd className="flex min-w-0 flex-col">
      <span className="text-text-primary [text-wrap:pretty]">{lines.primary}</span>
      <span className="text-text-secondary [text-wrap:pretty]">{lines.detail}</span>
    </dd>
  );
}

/** The list's shape while its first read is out, past the skeleton gate. */
function AttentionSkeleton() {
  return (
    <Skeleton label="Loading answers" className="flex flex-col gap-2 py-4">
      <SkeletonBone className="h-4 w-3/4" />
      <SkeletonBone className="h-3 w-1/2" />
      <SkeletonBone className="h-3 w-2/3" />
      <SkeletonBone className="h-14 w-full rounded-[var(--radius-md)]" />
    </Skeleton>
  );
}

interface DecisionsAttentionDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * The answers Daintree couldn't type in on its own (#16020): the pane that
 * asked was relaunched or closed, its worktree removed, resuming it failed,
 * or a crash left it unknown whether the answer went in. Each can be copied,
 * resumed into its agent, sent to another running agent after a
 * confirmation naming both panes, or marked handled. Nothing here is typed
 * in until the person chooses.
 */
export function DecisionsAttentionDialog({ isOpen, onClose }: DecisionsAttentionDialogProps) {
  const request = useDecisionsAttentionStore((state) => state.request);
  const announce = useAnnouncerStore((state) => state.announce);
  const worktreeName = useWorktreeNames();
  const [list, setList] = useState<DecisionsAttentionList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlyMap<string, Busy>>(new Map());
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [move, setMove] = useState<PendingMove | null>(null);
  /** The item Mark handled is asking about (#16638). */
  const [handling, setHandling] = useState<DecisionsAttentionItem | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** The row a confirmation was opened from, for its close to land after it. */
  const confirmFrom = useRef<{ questionId: string; index: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** The place in the list of an item whose action may take it off, for focus to land after. */
  const focusAfter = useRef<{ questionId: string; index: number } | null>(null);
  const reading = useRef(0);
  /**
   * The opening whose read is being committed. Regrouping can move the row
   * holding focus, and React hands focus back to it after the commit: that
   * is no one's move.
   */
  const settling = useRef(0);
  /** The opening reads are launched for now, and the pane it was opened for. */
  const opening = useRef<{ seq: number; terminalId: string | null }>({ seq: 0, terminalId: null });
  /**
   * The opening the shown list was read for: its items are grouped for that
   * opening's pane, and change places only when a read for a new one lands.
   */
  const [listedFor, setListedFor] = useState<{ seq: number; terminalId: string | null }>({
    seq: 0,
    terminalId: null,
  });
  /**
   * The opening the shown list or error was read in. The host keeps the last
   * opening's list mounted, so a reopening shows it until its own read lands.
   */
  const [readFor, setReadFor] = useState(0);
  const showSkeleton = useSkeletonGate(isOpen && list === null && loadError === null);

  const items = useMemo(() => (list?.result === "listed" ? list.items : []), [list]);
  const groups = useMemo(
    () => groupForPane(items, listedFor.terminalId),
    [items, listedFor.terminalId]
  );
  /** The questions in the order they show, which a row that leaves hands focus on by. */
  const shown = useMemo(
    () => (groups === null ? items : [...groups.forPane, ...groups.elsewhere]),
    [groups, items]
  );
  // Said only of this opening's own pane, once its own read has listed the rows: until
  // then (or when it failed) the rows keep their places, unlabelled, rather than
  // name the new pane's own items as elsewhere.
  const ownRead = listedFor.seq === request.seq;
  const elsewhereStart = ownRead ? (groups?.elsewhere[0]?.questionId ?? null) : null;
  const noneForPane =
    ownRead && groups !== null && groups.forPane.length === 0 && groups.elsewhere.length > 0;

  const refresh = useCallback(async () => {
    const ticket = ++reading.current;
    const launchedFor = opening.current;
    try {
      const next = await decisionsClient.listAttention();
      if (ticket !== reading.current) return;
      settling.current = launchedFor.seq;
      setList(next);
      setListedFor(launchedFor);
      setLoadError(null);
    } catch (error) {
      if (ticket !== reading.current) return;
      setLoadError(formatErrorMessage(error, "Couldn't read the answers"));
    }
    setReadFor(launchedFor.seq);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    opening.current = { seq: request.seq, terminalId: request.terminalId };
    setOutcome(null);
    void refresh();
  }, [isOpen, request.seq, request.terminalId, refresh]);

  // A confirmation belongs to the opening it was asked in: closing the list
  // takes it with it, so a reopening never shows one for an item it never asked about.
  useEffect(() => {
    if (isOpen) return;
    setMove(null);
    setHandling(null);
  }, [isOpen]);

  // Panes' Decisions state changes whenever an answer moves, but reaches only
  // their project's window; the question list reaches every window here, so
  // one handled or delivered from another leaves this one too (#17944). Read
  // again once a burst of either settles.
  useEffect(() => {
    if (!isOpen) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
    };
    // The question list changes for every question here and on every Host;
    // only a change to what needs a person is a reason to read this list.
    let seen: string | null = null;
    const listChanged = (latest: DecisionQuestionList) => {
      const next = attentionFingerprint(latest.questions);
      if (next === seen) return;
      seen = next;
      changed();
    };
    const offs: (() => void)[] = [];
    const subscriptions = [
      () => decisionsClient.onPaneState(changed),
      () => decisionsClient.onQuestionsChanged(listChanged),
    ];
    for (const subscribe of subscriptions) {
      try {
        offs.push(subscribe());
      } catch {
        // A bridge without the event leaves the other, and the list's own reads.
      }
    }
    return () => {
      if (timer !== null) clearTimeout(timer);
      for (const off of offs) off();
    };
  }, [isOpen, refresh]);

  // Opened for a pane — from its chip, or from its run in Canopy: its first
  // answer's first action takes the focus once this opening's own read is
  // listed, ringed when the keyboard brought the person here. A reopening
  // still shows the last opening's list until then, which may not have the
  // pane's answer yet. With none listed for that pane, or no list read, the
  // list itself holds it.
  const focusedFor = useRef(0);
  /** The opening during whose read the person moved focus, which then stays theirs. */
  const focusMovedFor = useRef(0);
  useEffect(() => {
    if (!isOpen || request.terminalId === null || focusedFor.current === request.seq) {
      return undefined;
    }
    const seq = request.seq;
    if (readFor !== seq) {
      // A control in a modal, this one or a confirmation over it, is the
      // person's move. This one's surface taking focus as it opens, the list's
      // place taking it from a click on no control, the element that held
      // focus when the window lost it taking it again as the window comes
      // back, and focus behind every modal (a popover handing it back to the
      // chip that opened the list) are not.
      // The window may already be away as the opening begins.
      let heldAtWindowBlur = document.hasFocus() ? null : document.activeElement;
      // Blur doesn't bubble, so outside the capture phase only the window's own arrives.
      const onWindowBlur = () => {
        heldAtWindowBlur = document.activeElement;
      };
      const onFocusIn = (event: FocusEvent) => {
        if (settling.current === seq) return;
        const { target } = event;
        const replayed = target === heldAtWindowBlur;
        heldAtWindowBlur = null;
        const body = bodyRef.current;
        if (replayed || !(target instanceof Element) || body === null) return;
        if (target.contains(body) || target.closest('[aria-modal="true"]') === null) return;
        focusMovedFor.current = seq;
      };
      window.addEventListener("blur", onWindowBlur);
      document.addEventListener("focusin", onFocusIn, true);
      return () => {
        window.removeEventListener("blur", onWindowBlur);
        document.removeEventListener("focusin", onFocusIn, true);
      };
    }
    focusedFor.current = seq;
    settling.current = 0;
    // A control the refresh took away leaves focus on nothing, which no one chose.
    const active = document.activeElement;
    const kept = active !== null && active !== document.body;
    if (focusMovedFor.current === seq && kept) return undefined;
    // A modal over this one (the question view, a confirmation) keeps the focus it holds.
    const over = active?.closest('[aria-modal="true"]') ?? null;
    if (over !== null && bodyRef.current !== null && !over.contains(bodyRef.current)) {
      return undefined;
    }
    // This opening's read has landed, so the rows marked for its pane are its pane's own.
    const target =
      loadError === null
        ? listRef.current?.querySelector<HTMLElement>(`[data-for-pane] ${ITEM_ACTIONS}`)
        : null;
    if (target) {
      target.focus({ preventScroll: true });
      // The whole answer comes into view, padding included: scrolled only as
      // far as its action, the last answer's focus ring sat under the footer.
      target.closest<HTMLElement>("[data-question-id]")?.scrollIntoView({ block: "nearest" });
    } else bodyRef.current?.focus({ focusVisible: false } as FocusOptions);
    return undefined;
  }, [isOpen, loadError, readFor, request]);

  // A confirmation asks about the item as it was read: once the list no longer
  // shows it so (handled in another window, its round replaced, delivered),
  // the confirmation goes rather than act on whatever the question holds now.
  useEffect(() => {
    if (list === null) return;
    const stillShown = (asked: DecisionsAttentionItem) =>
      items.some((item) => sameAttention(item, asked));
    if (handling !== null && !stillShown(handling)) setHandling(null);
    if (move !== null && !stillShown(move.item)) setMove(null);
  }, [items, list, handling, move]);

  // A row that moves keeps its saved place current, so when it does leave,
  // focus goes to the row that followed it where it last showed.
  useEffect(() => {
    for (const saved of [confirmFrom, focusAfter]) {
      const at = saved.current;
      if (at === null) continue;
      const index = shown.findIndex((item) => item.questionId === at.questionId);
      if (index !== -1 && index !== at.index) saved.current = { ...at, index };
    }
  }, [shown]);

  // An item that left took the focus with it: the next one's first action
  // gets it, else the one before, else the list's own place in the dialog.
  useEffect(() => {
    const pending = focusAfter.current;
    if (pending === null || list === null) return;
    if (items.some((item) => item.questionId === pending.questionId)) return;
    focusAfter.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body && document.contains(active)) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-question-id]") ?? [];
    const row = rows[Math.min(pending.index, rows.length - 1)];
    const next = row?.querySelector<HTMLElement>(ITEM_ACTIONS);
    if (next) next.focus();
    else bodyRef.current?.focus({ focusVisible: false } as FocusOptions);
  }, [items, list]);

  const run = async (
    item: DecisionsAttentionItem,
    kind: Busy,
    action: () => Promise<DecisionsAnswerOutcome>
  ) => {
    setBusy((current) => new Map(current).set(item.questionId, kind));
    if (kind === "resume")
      announce(`Resuming the agent for ${aliasLabel(item.alias)}. ${RESUME_PENDING}`);
    focusAfter.current = {
      questionId: item.questionId,
      index: shown.findIndex((candidate) => candidate.questionId === item.questionId),
    };
    let next: Outcome;
    try {
      const result = await action();
      next = {
        message: outcomeText(item.alias, result, subjectOf(item)),
        severity: outcomeSeverity(result),
      };
      if (!leavesList(result)) focusAfter.current = null;
    } catch (error) {
      focusAfter.current = null;
      next = {
        message: formatErrorMessage(
          error,
          `Couldn't change ${aliasLabel(item.alias)}'s ${subjectOf(item)}`
        ),
        severity: "warning",
      };
    }
    setBusy((current) => {
      const remaining = new Map(current);
      remaining.delete(item.questionId);
      return remaining;
    });
    setOutcome(next);
    announce(next.message);
    await refresh();
  };

  const askAbout = (item: DecisionsAttentionItem) => {
    confirmFrom.current = {
      questionId: item.questionId,
      index: shown.findIndex((candidate) => candidate.questionId === item.questionId),
    };
  };

  // The item's token goes with it: main refuses once the question asks something else (#17944).
  const markHandled = (item: DecisionsAttentionItem) =>
    void run(item, "handled", () => decisionsClient.markAnswerHandled(item.questionId, item.token));

  const confirmHandled = () => {
    if (handling === null) return;
    const item = handling;
    setHandling(null);
    markHandled(item);
  };

  const confirmMove = () => {
    if (move === null) return;
    const { item, destination } = move;
    setMove(null);
    void run(item, "reassign", () =>
      decisionsClient.reassignAnswer(item.questionId, destination.terminalId, item.token)
    );
  };

  // Opened from a chip, the close returns to that pane: its chip while it
  // shows, else the pane itself, since the chip goes with its last answer.
  // An opener that named its own successor (a Canopy row) gets that instead.
  const restoreFocusTo = useCallback((): HTMLElement | null => {
    if (request.returnFocusTo !== null) {
      return document.getElementById(request.returnFocusTo);
    }
    const id = request.terminalId;
    if (id === null) return null;
    const escaped = CSS.escape(id);
    const pane =
      document.querySelector<HTMLElement>(
        `[data-panel-id="${escaped}"][data-panel-location="grid"]`
      ) ?? document.querySelector<HTMLElement>(`[data-panel-id="${escaped}"]`);
    return pane?.querySelector<HTMLElement>(PANE_CHIP) ?? pane;
  }, [request.terminalId, request.returnFocusTo]);

  const restoreAfterConfirm = useCallback((): HTMLElement | null => {
    const from = confirmFrom.current;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-question-id]") ?? [])];
    if (from !== null && rows.length > 0) {
      const row =
        rows.find((candidate) => candidate.dataset.questionId === from.questionId) ??
        rows[Math.min(Math.max(from.index, 0), rows.length - 1)];
      const target = row?.querySelector<HTMLElement>(ITEM_ACTIONS);
      if (target) return target;
    }
    return bodyRef.current;
  }, []);

  const count = items.length;
  const empty = list?.result === "listed" && count === 0;

  return (
    <>
      <AppDialog
        isOpen={isOpen}
        onClose={onClose}
        size="lg"
        maxHeight="max-h-[min(44rem,85vh)]"
        initialFocus="surface"
        restoreFocusTo={restoreFocusTo}
        data-testid="decisions-attention-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title icon={<DecisionsIcon size={16} />}>
            Answers needing attention
          </AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        {/* What the last action did stays in view, however far the list scrolled. */}
        {outcome !== null && (
          <div className="px-6 pt-1" data-testid="decisions-attention-outcome">
            <Callout severity={outcome.severity} size="compact">
              {outcome.message}
            </Callout>
          </div>
        )}
        <AppDialog.Body>
          {/* Focus lands here only when no row is left to take it; ringed when
              the keyboard brought it, like any other stop. */}
          <div
            ref={bodyRef}
            tabIndex={-1}
            className="flex flex-col rounded-[var(--radius-sm)] outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
          >
            <AppDialog.Description className="text-xs text-text-secondary [text-wrap:pretty]">
              {empty ? EMPTY_DESCRIPTION : LIST_DESCRIPTION}
            </AppDialog.Description>
            {loadError !== null && (
              <Callout
                severity="warning"
                size="compact"
                className="mt-3"
                action={
                  <Button variant="outline" size="xs" onClick={() => void refresh()}>
                    Retry
                  </Button>
                }
              >
                {loadError}
              </Callout>
            )}
            {list === null && loadError === null && showSkeleton && <AttentionSkeleton />}
            {list?.result === "not-running" && (
              <p className="py-4 text-xs text-text-secondary [text-wrap:pretty]">
                Decisions isn't delivering answers on this computer right now, so none can be read.
                Set up or reconnect the relay in Settings → Decisions.
              </p>
            )}
            {noneForPane && (
              <p
                className="pt-4 text-xs text-text-secondary [text-wrap:pretty]"
                data-testid="decisions-attention-none-for-pane"
              >
                {NONE_FOR_PANE}
              </p>
            )}
            {count > 0 && (
              <ul
                ref={listRef}
                aria-label={`${pluralize(count, "question")} needing attention`}
                className="flex flex-col divide-y divide-divider"
              >
                {/* One list, keyed by question, so a row keeps its place in the DOM, and its
                    focus, as the opening pane's items come to lead it. */}
                {shown.map((item) => (
                  <AttentionItem
                    key={item.questionId}
                    item={item}
                    heading={item.questionId === elsewhereStart ? ELSEWHERE_HEADING : undefined}
                    forPane={groups?.forPane.includes(item) ?? false}
                    worktreeName={worktreeName}
                    busy={busy.get(item.questionId) ?? null}
                    onResume={() =>
                      void run(item, "resume", () => decisionsClient.resumeAnswer(item.questionId))
                    }
                    onChoose={(destination) => {
                      askAbout(item);
                      setMove({ item, destination });
                    }}
                    onHandled={() => {
                      if (!handledNeedsConfirm(item)) {
                        markHandled(item);
                        return;
                      }
                      askAbout(item);
                      setHandling(item);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </AppDialog.Body>
        {/* How many are left, and a rule that marks more below when the list scrolls. */}
        {count > 0 && <AppDialog.Footer hint={remainingText(count)} />}
      </AppDialog>
      <ConfirmDialog
        isOpen={move !== null}
        onClose={() => setMove(null)}
        zIndex="nested"
        variant="default"
        title={
          move === null
            ? ""
            : `Send ${aliasLabel(move.item.alias)}'s ${subjectOf(move.item)} to ${paneName(
                move.destination.title,
                agentLabel(move.destination)
              )}?`
        }
        description={
          <span className="[text-wrap:pretty]">
            {move === null ? "" : moveConfirmBody(subjectOf(move.item), move.destination.waitsFor)}
          </span>
        }
        // The menu that opened it is its row's; when a fast move has already
        // taken that row away, the close lands on the next row, else the one
        // before, else the list's own place.
        restoreFocusTo={restoreAfterConfirm}
        confirmLabel={move === null ? "Send answer" : `Send ${subjectOf(move.item)}`}
        onConfirm={confirmMove}
      >
        {move !== null && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2 text-xs">
            {move.item.question !== null && (
              <>
                <dt className="text-text-secondary">Question</dt>
                <dd className="text-text-primary [text-wrap:pretty]">{move.item.question}</dd>
              </>
            )}
            <dt className="text-text-secondary">From</dt>
            <PaneLinesValue
              lines={fromLines(
                move.item,
                worktreeName(move.item.origin.worktreeId, move.item.origin.worktreeName)
              )}
            />
            <dt className="text-text-secondary">To</dt>
            <PaneLinesValue
              lines={toLines(
                move.destination,
                worktreeName(move.destination.worktreeId, move.destination.worktreeName)
              )}
            />
          </dl>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={handling !== null}
        onClose={() => setHandling(null)}
        zIndex="nested"
        variant="destructive"
        title={handling === null ? "" : handledConfirmTitle(handling.alias)}
        description={
          <span className="[text-wrap:pretty]">
            {handledConfirmBody(handling === null ? "answer" : subjectOf(handling))}
          </span>
        }
        // Cancelling returns to the button that asked; once the row is gone,
        // the close lands on the next row, else the one before, else the
        // list's own place.
        restoreFocusTo={restoreAfterConfirm}
        confirmLabel="Mark handled"
        onConfirm={confirmHandled}
      >
        {handling !== null && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2 text-xs">
            {handling.question !== null && (
              <>
                <dt className="text-text-secondary">Question</dt>
                <dd className="text-text-primary [text-wrap:pretty]">{handling.question}</dd>
              </>
            )}
            <dt className="text-text-secondary">From</dt>
            <PaneLinesValue
              lines={fromLines(
                handling,
                worktreeName(handling.origin.worktreeId, handling.origin.worktreeName)
              )}
            />
          </dl>
        )}
      </ConfirmDialog>
    </>
  );
}
