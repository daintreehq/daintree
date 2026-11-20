import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DecisionsIcon, TriangleAlert } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { decisionsClient } from "@/clients/decisionsClient";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";
import { pluralize } from "@/lib/pluralize";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionQuestionList } from "@shared/types/decisionsQuestion";
import type {
  DecisionsAnswerDestination,
  DecisionsAttentionItem,
  DecisionsAttentionList,
  DecisionsFollowUpPreview,
  DecisionsTimeoutNotice,
} from "@shared/types/decisionsAttention";
import {
  ATTENTION_ACTIONS,
  AttentionActionRow,
  AttentionConfirmations,
  ResumePending,
  useWorktreeNames,
  type WorktreeName,
} from "./AttentionActions";
import {
  ELSEWHERE_HEADING,
  EMPTY_DESCRIPTION,
  LIST_DESCRIPTION,
  NONE_FOR_PANE,
  PLAN_CAPTION,
  aliasLabel,
  attentionFingerprint,
  canOpenQuestion,
  groupForPane,
  hasFullerQuestion,
  leavesList,
  missingAnswerText,
  noticeDeliveryText,
  noticeOutcomeText,
  noticePlanText,
  originParts,
  reasonText,
  remainingText,
  statusText,
  subjectOf,
} from "./decisionsAttentionModel";
import { useAttentionActions, type AttentionBusy } from "./useAttentionActions";

/** A pane's Decisions chip, where the close returns when the list was opened from it. */
const PANE_CHIP = '[data-testid="terminal-decisions-chip"]';

/** Pushes for panes arrive in bursts; one read after they settle. */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Whether `element` is in a modal over the list whose body is `body` (the
 * question view, a confirmation), not in the list's own or in one under it
 * (the inbox it was opened from). Each modal's portal follows the ones open
 * before it.
 */
function inModalOver(body: HTMLElement | null, element: Element): boolean {
  const own = body?.closest('[aria-modal="true"]') ?? null;
  const modal = element.closest('[aria-modal="true"]');
  if (own === null || modal === null || modal === own) return false;
  return Boolean(own.compareDocumentPosition(modal) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/**
 * Whether a folded quote's text runs past its clamp, measured as it shows,
 * as it folds back, and as a narrowing clamps it. Once offered for a text,
 * the toggle stays until the text changes: a widening, or folding it back
 * once it fits, would otherwise take away the button the person is on.
 */
function useClamped(text: string | null | undefined, expanded: boolean) {
  const textRef = useRef<HTMLQuoteElement>(null);
  const [offered, setOffered] = useState<{ text: string } | null>(null);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el === null || expanded || text == null) return;
    const offer = () => {
      if (el.scrollHeight > el.clientHeight + 1) setOffered({ text });
    };
    offer();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(offer);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);
  return { textRef, clamped: offered !== null && offered.text === text };
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
  busy: AttentionBusy | null;
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
  const alias = aliasLabel(item.alias);
  const { pane, place } = originParts(
    item,
    worktreeName(item.origin.worktreeId, item.origin.worktreeName)
  );
  const reason = reasonText(item.reason, subjectOf(item));
  const locked = busy !== null;

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
      <AttentionActionRow
        item={item}
        worktreeName={worktreeName}
        busy={busy}
        onResume={onResume}
        onChoose={onChoose}
        onHandled={onHandled}
        className="pt-0.5"
      />
      <ResumePending alias={item.alias} active={busy === "resume"} />
    </li>
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
  const worktreeName = useWorktreeNames();
  const [list, setList] = useState<DecisionsAttentionList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** The row a confirmation was opened from, for its close to land after it. */
  const confirmFrom = useRef<{ questionId: string; index: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** The place in the list of an item whose action may take it off, for focus to land after. */
  const focusAfter = useRef<{ questionId: string; index: number } | null>(null);
  const reading = useRef(0);
  /**
   * The opening whose read is being committed, and what held focus as it
   * came back. Regrouping can move that row, and React hands focus back to
   * it after the commit: that is no one's move, where focus going anywhere
   * else meanwhile is.
   */
  const settling = useRef<{ seq: number; held: Element | null } | null>(null);
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
   * The opening in which an action took an item off the list: the next read
   * for it that lists nothing closes the list rather than leave it empty (#18027).
   */
  const closeWhenEmpty = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
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
      settling.current = { seq: launchedFor.seq, held: document.activeElement };
      setList(next);
      setListedFor(launchedFor);
      setLoadError(null);
      // The first read that lands after the action decides, once: a list
      // emptied by another window, or one opened empty, stays open.
      if (closeWhenEmpty.current !== null && closeWhenEmpty.current === launchedFor.seq) {
        closeWhenEmpty.current = null;
        if (next.result === "listed" && next.items.length === 0) onCloseRef.current();
      }
    } catch (error) {
      // A read that failed says nothing of what is left: the next one decides.
      if (ticket !== reading.current) return;
      setLoadError(formatErrorMessage(error, "Couldn't read the answers"));
    }
    setReadFor(launchedFor.seq);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      closeWhenEmpty.current = null;
      return;
    }
    opening.current = { seq: request.seq, terminalId: request.terminalId };
    void refresh();
  }, [isOpen, request.seq, request.terminalId, refresh]);

  // An action and its outcome belong to the opening they were taken in, so a reopening
  // never shows one for an item it never asked about; a confirmation goes with the close.
  const actions = useAttentionActions({
    scope: isOpen ? `open:${request.seq}` : null,
    confirmScope: isOpen ? "open" : null,
    shown: list === null ? null : items,
    refresh,
    onAsk: (item) => {
      confirmFrom.current = {
        questionId: item.questionId,
        index: shown.findIndex((candidate) => candidate.questionId === item.questionId),
      };
    },
    onStart: (item) => {
      focusAfter.current = {
        questionId: item.questionId,
        index: shown.findIndex((candidate) => candidate.questionId === item.questionId),
      };
    },
    onSettled: (item, result, current) => {
      if (!current || result === null || !leavesList(result)) {
        // Only its own place: another action may have set one since.
        if (focusAfter.current?.questionId === item.questionId) focusAfter.current = null;
        return;
      }
      // `resolved` says it needed nothing by then: another window took it off.
      if (result.result !== "resolved") closeWhenEmpty.current = opening.current.seq;
    },
  });
  const { busy, outcome } = actions;
  /** One of this list's confirmations is open over it. */
  const asking = actions.move !== null || actions.handling !== null;

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
        const { target } = event;
        if (settling.current?.seq === seq && target === settling.current.held) return;
        const replayed = target === heldAtWindowBlur;
        heldAtWindowBlur = null;
        const body = bodyRef.current;
        if (replayed || !(target instanceof Element) || body === null) return;
        if (target.contains(body)) return;
        // A control in this list, or in a modal over it, is the person's; one under it isn't.
        if (!body.closest('[aria-modal="true"]')?.contains(target) && !inModalOver(body, target)) {
          return;
        }
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
    settling.current = null;
    // A control the refresh took away leaves focus on nothing, which no one chose.
    const active = document.activeElement;
    const kept = active !== null && active !== document.body;
    if (focusMovedFor.current === seq && kept) return undefined;
    // A modal over this one keeps the focus it holds; one under it doesn't.
    if (active !== null && inModalOver(bodyRef.current, active)) return undefined;
    // One of this list's confirmations, still open over it, keeps the keyboard it already had.
    if (asking && kept) return undefined;
    // This opening's read has landed, so the rows marked for its pane are its pane's own.
    const target =
      loadError === null
        ? listRef.current?.querySelector<HTMLElement>(`[data-for-pane] ${ATTENTION_ACTIONS}`)
        : null;
    if (target) {
      target.focus({ preventScroll: true });
      // The whole answer comes into view, padding included: scrolled only as
      // far as its action, the last answer's focus ring sat under the footer.
      target.closest<HTMLElement>("[data-question-id]")?.scrollIntoView({ block: "nearest" });
    } else bodyRef.current?.focus({ focusVisible: false } as FocusOptions);
    return undefined;
  }, [isOpen, loadError, readFor, request, asking]);

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
    const next = row?.querySelector<HTMLElement>(ATTENTION_ACTIONS);
    if (next) next.focus();
    else bodyRef.current?.focus({ focusVisible: false } as FocusOptions);
  }, [items, list]);

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
      const target = row?.querySelector<HTMLElement>(ATTENTION_ACTIONS);
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
                    onResume={() => actions.resume(item)}
                    onChoose={(destination) => actions.choose(item, destination)}
                    onHandled={() => actions.handle(item)}
                  />
                ))}
              </ul>
            )}
          </div>
        </AppDialog.Body>
        {/* How many are left, and a rule that marks more below when the list scrolls. */}
        {count > 0 && <AppDialog.Footer hint={remainingText(count)} />}
      </AppDialog>
      <AttentionConfirmations
        actions={actions}
        worktreeName={worktreeName}
        // The menu or button that opened it is its row's; when a fast action has
        // already taken that row away, the close lands on the next row, else the
        // one before, else the list's own place.
        restoreFocusTo={restoreAfterConfirm}
        restoreFocusOnClose={isOpen}
      />
    </>
  );
}
