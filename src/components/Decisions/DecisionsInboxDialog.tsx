import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { DecisionsIcon, TriangleAlert } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { FactRun } from "@/components/ui/FactSeparator";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TimeAgo } from "@/components/ui/TimeAgo";
import {
  LIST_DETAIL_ROW_CLASS,
  PALETTE_ROW_FOCUS_CLASS,
  PALETTE_SECTION_LABEL_CLASS,
} from "@/components/ui/paletteRowStyles";
import { decisionsClient } from "@/clients/decisionsClient";
import { terminalClient } from "@/clients/terminalClient";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";
import { useDecisionsSwitch } from "@/hooks/useDecisionsOn";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { useRovingRows } from "@/hooks/useRovingRows";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { worktreeDisplayName } from "@/utils/recipeScope";
import type { WorktreeSnapshot } from "@shared/types";
import type { DecisionsStatus } from "@shared/types/decisions";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
} from "@shared/types/decisionsQuestion";
import { DecisionCancelDialog } from "./DecisionCancelDialog";
import { DecisionsInvolvementSection } from "./DecisionsInvolvementSection";
import { DecisionQuestionReadView } from "./DecisionQuestionReader";
import { aliasLabel } from "./decisionQuestionModel";
import { referencedQuestion, type DecisionQuestionTarget } from "./decisionQuestionTarget";
import {
  agentName,
  connectionNotice,
  emptyText,
  inboxGroups,
  isAttention,
  originFacts,
  referenceKey,
  resolveSelection,
  standingText,
  worktreeName,
  type InboxChoice,
  type InboxGroup,
} from "./decisionsInboxModel";
import {
  useDecisionQuestionReader,
  useDecisionsReaderRetention,
  useQuestionCancel,
} from "./useDecisionQuestionReader";

/** A pane's Decisions chip, where the close returns when the inbox was opened from it. */
const PANE_CHIP = '[data-testid="terminal-decisions-chip"]';

/** The IPC read takes at most this many references at once. */
const SUMMARY_BATCH = 64;

/** While another project's question is shown, how often its terminal is looked for again. */
const REACH_RECHECK_MS = 15_000;

type ListRead =
  { state: "loading" } | { state: "failed" } | { state: "listed"; list: DecisionQuestionList };

const LOADING: ListRead = { state: "loading" };
const NO_LINES: ReadonlyMap<string, string | null> = new Map();
const NO_WORKTREES = new Map<string, WorktreeSnapshot>();

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
        const batch = missing.slice(start, start + SUMMARY_BATCH);
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
 * Whether the terminal that asked the question is still open on this
 * computer. This view's own panels answer for this project, as they change;
 * for another, the terminals this computer runs, looked for again a while
 * after each look settles. A Remote Host window's terminals are another
 * computer's, so from one it offers nothing.
 */
function useTerminalReach(
  item: DecisionQuestionListItem | null,
  active: boolean
): { reach: TerminalReach; markGone: (key: string) => void } {
  const remote = isRemoteWindow();
  const terminalId = item?.reference.terminalId ?? null;
  const projectId = item?.reference.projectId ?? null;
  const here = !remote && projectId !== null && projectId === getViewWorkspaceId();
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
    if (!active || remote || here || key === null || terminalId === null || projectId === null) {
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
  }, [active, remote, here, key, terminalId, projectId, epoch]);

  const markGone = useCallback((gone: string) => {
    looks.current += 1;
    setFound({ key: gone, open: false });
    setEpoch((n) => n + 1);
  }, []);
  if (item === null || remote) return { reach: null, markGone };
  if (here) return { reach: openHere ? "here" : null, markGone };
  return {
    reach: found !== null && found.key === key && found.open ? "elsewhere" : null,
    markGone,
  };
}

function ListSkeleton() {
  return (
    <Skeleton label="Loading questions" className="flex flex-col gap-3 px-1 py-1">
      <SkeletonBone className="h-3 w-1/3" />
      <SkeletonBone className="h-9 w-full" />
      <SkeletonBone className="h-9 w-full" />
      <SkeletonBone className="h-9 w-4/5" />
    </Skeleton>
  );
}

function InboxRow({
  item,
  rowKey,
  line,
  origin,
  selected,
  tabStop,
  rowRef,
  onFocus,
  onSelect,
}: {
  item: DecisionQuestionListItem;
  rowKey: string;
  line: string | null;
  origin: readonly string[];
  selected: boolean;
  tabStop: boolean;
  rowRef: (element: HTMLElement | null) => void;
  onFocus: (element: HTMLElement) => void;
  onSelect: () => void;
}) {
  const attention = isAttention(item.standing);
  return (
    <li>
      <button
        type="button"
        ref={rowRef}
        // One tab stop for the whole list; the arrow keys move it.
        tabIndex={tabStop ? 0 : -1}
        aria-current={selected || undefined}
        data-roving-row=""
        data-inbox-key={encodeURIComponent(rowKey)}
        data-selected={selected ? "true" : undefined}
        onFocus={(event) => onFocus(event.currentTarget)}
        onClick={onSelect}
        className={cn(
          LIST_DETAIL_ROW_CLASS,
          PALETTE_ROW_FOCUS_CLASS,
          "flex w-full flex-col gap-0.5 rounded-[var(--radius-md)] px-2.5 py-2 text-left"
        )}
        data-testid="decisions-inbox-row"
      >
        <span className="flex w-full min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-xs text-text-primary tabular-nums">
            {aliasLabel(item.alias)}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary"
            data-testid="decisions-inbox-row-line"
          >
            {line ?? ""}
          </span>
          <TimeAgo
            timestamp={item.askedAt}
            prefix="asked "
            className="shrink-0 text-3xs text-text-secondary"
          />
        </span>
        {/* The glyph marks the state's first line, however many it wraps to. */}
        <span className="flex items-start gap-1 text-2xs text-text-secondary [text-wrap:pretty]">
          {attention && (
            <TriangleAlert
              className="mt-0.5 size-3 shrink-0 text-status-warning"
              aria-hidden="true"
            />
          )}
          {standingText(item.standing)}
        </span>
        <span className="w-full truncate text-2xs text-text-secondary">
          <FactRun facts={origin} />
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
  groups,
  lines,
  originOf,
  selectedKey,
  onSelect,
}: {
  groups: readonly InboxGroup[];
  lines: ReadonlyMap<string, string | null>;
  originOf: (item: DecisionQuestionListItem) => readonly string[];
  selectedKey: string | null;
  onSelect: (key: string, index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const ordered = groups.flatMap((group) => group.items);
  const keys = ordered.map((item) => referenceKey(item.reference));
  const roving = useRovingRows({ keys, preferredKey: selectedKey, containerRef: listRef });
  // The row the keyboard was on, until focus goes somewhere else on purpose.
  const lastFocused = useRef<{ key: string; element: HTMLElement } | null>(null);
  const shape = groups
    .flatMap((group) => group.items.map((item) => `${group.id}:${referenceKey(item.reference)}`))
    .join("\n");

  // A row that moves to another group is a new element, and the old one took
  // focus with it; the keyboard goes back to the row, or to the list's stop.
  useLayoutEffect(() => {
    const last = lastFocused.current;
    const list = listRef.current;
    // Only for the row that went: one still in place lost focus some other way.
    if (last === null || list === null || last.element.isConnected) return;
    lastFocused.current = null;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) return;
    const row =
      list.querySelector<HTMLElement>(`[data-inbox-key="${encodeURIComponent(last.key)}"]`) ??
      list.querySelector<HTMLElement>('[data-roving-row][tabindex="0"]');
    row?.focus({ preventScroll: true });
  }, [shape]);

  return (
    <div
      ref={listRef}
      onKeyDown={roving.onKeyDown}
      tabIndex={roving.containerProps.tabIndex}
      onFocus={roving.containerProps.onFocus}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) {
          lastFocused.current = null;
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
      className="flex flex-col gap-3"
      data-testid="decisions-inbox-groups"
    >
      <span id={labelId} className="sr-only">
        Questions
      </span>
      {groups.map((group) => {
        const headingId = `${labelId}-${group.id}`;
        return (
          <section
            key={group.id}
            aria-labelledby={headingId}
            className="flex flex-col gap-0.5"
            data-testid={`decisions-inbox-group-${group.id}`}
          >
            <h3
              id={headingId}
              className={cn(PALETTE_SECTION_LABEL_CLASS, "flex items-baseline gap-1.5 px-1")}
            >
              {group.title}
              <span className="tabular-nums">{group.items.length.toLocaleString()}</span>
            </h3>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const key = referenceKey(item.reference);
                return (
                  <InboxRow
                    key={key}
                    item={item}
                    rowKey={key}
                    line={lines.get(key) ?? null}
                    origin={originOf(item)}
                    selected={key === selectedKey}
                    tabStop={key === roving.tabStopKey}
                    rowRef={roving.rowRef(key)}
                    onFocus={(element) => {
                      lastFocused.current = { key, element };
                      roving.onRowFocus(key);
                    }}
                    onSelect={() => onSelect(key, keys.indexOf(key))}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Every question this computer's Decisions holds (#17231), across its
 * projects and terminals, grouped by what it needs: the person, delivery, or
 * a decision about a stopped delivery, then history. Selecting one reads it
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
  const groups = questions === null ? [] : inboxGroups(questions);
  const ordered = groups.flatMap((group) => group.items);
  const { lines, release: releaseLines } = useQuestionLines(ordered, active);

  const remote = isRemoteWindow();
  const projects = useProjectStore((state) => state.projects);
  const worktrees = useWorktreeStoreOptional((state) => state.worktrees, NO_WORKTREES);
  const viewWorkspace = getViewWorkspaceId();
  // A Remote Host window's projects are another computer's, whatever their
  // ids: a question there keeps the names it was asked under.
  const originOf = (item: DecisionQuestionListItem): string[] => {
    const local = !remote && item.reference.projectId === viewWorkspace;
    const project =
      (remote
        ? undefined
        : projects.find((candidate) => candidate.id === item.reference.projectId)?.name) ??
      item.projectLabel;
    const known = local ? (worktreeDisplayName(worktrees.get(item.worktreeId)) ?? null) : null;
    return originFacts({
      agent: agentName(item.agentKind),
      project,
      worktree: worktreeName(item, known),
    });
  };

  // The question shown sticks to the one chosen, by reference, as the list moves around it.
  const [choice, setChoice] = useState<(InboxChoice & { seq: number }) | null>(null);
  const chosen = choice !== null && choice.seq === request.seq ? choice : null;
  const selected = resolveSelection(ordered, chosen, request.terminalId);
  const selectedKey = selected === null ? null : referenceKey(selected.reference);
  const selectedIndex = selected === null ? -1 : ordered.indexOf(selected);
  if (
    selectedKey !== null &&
    (chosen === null || chosen.key !== selectedKey || chosen.index !== selectedIndex)
  ) {
    setChoice({ seq: request.seq, key: selectedKey, index: selectedIndex });
  }

  // One target per question, so a push that only renews the list's objects
  // doesn't start the reader's reads over.
  const [target, setTarget] = useState<{ key: string; target: DecisionQuestionTarget } | null>(
    null
  );
  if (selected !== null && selectedKey !== null && target?.key !== selectedKey) {
    setTarget({ key: selectedKey, target: referencedQuestion(selected.reference) });
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

  // Each look before going elsewhere belongs to the question shown when it
  // started, in this opening: closing, reopening or choosing another drops it.
  const navigation = useRef(0);
  useEffect(() => {
    navigation.current += 1;
  }, [isOpen, request.seq, selectedKey]);

  const detailRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const detailHeadingId = useId();

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
    releaseLines();
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
  // Only once the relay is known to be reachable does an empty list say nothing was asked.
  const empty =
    listRead.state === "listed" && statusKnown && notice === null ? emptyText(groups) : null;

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
        data-testid="decisions-inbox-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title icon={<DecisionsIcon size={16} />}>Decisions inbox</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        {/* Two columns that scroll on their own, so a plain element rather than the dialog's body column. */}
        <div className="flex min-h-0 flex-1 overflow-hidden border-t border-divider">
          <div
            className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto overscroll-contain border-r border-divider px-2 py-3 lg:w-80"
            data-testid="decisions-inbox-list"
          >
            {notice !== null && (
              <Callout
                severity={notice.severity}
                size="compact"
                data-testid="decisions-inbox-connection"
              >
                {notice.text}
              </Callout>
            )}
            {listRead.state === "loading" && showListSkeleton && <ListSkeleton />}
            {listRead.state === "failed" && (
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
            )}
            {empty !== null && (
              <p className="px-1 text-xs text-text-secondary" data-testid="decisions-inbox-empty">
                {empty}
              </p>
            )}
            {groups.length > 0 && (
              <InboxList
                groups={groups}
                lines={lines}
                originOf={originOf}
                selectedKey={selectedKey}
                onSelect={(key, index) => setChoice({ seq: request.seq, key, index })}
              />
            )}
          </div>
          <section
            ref={detailRef}
            // A stop of its own, so a question with nothing to press still scrolls from the keyboard.
            tabIndex={selected !== null ? 0 : -1}
            aria-labelledby={selected !== null ? detailHeadingId : undefined}
            className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
            data-testid="decisions-inbox-detail"
          >
            {selected !== null && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <h3
                      id={detailHeadingId}
                      className="text-sm font-semibold text-text-primary"
                      data-testid="decisions-inbox-detail-title"
                    >
                      Question {aliasLabel(selected.alias)}
                    </h3>
                    <p className="truncate text-xs text-text-secondary">
                      <FactRun facts={originOf(selected)} />
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {reach !== null && (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={goToTerminal}
                        data-testid="decisions-inbox-go-to-terminal"
                      >
                        Go to terminal
                      </Button>
                    )}
                    {reader.cancellable &&
                      (dismissal.progress !== null ? (
                        dismissal.phase?.kind === "lost" && (
                          <Button
                            ref={cancelRef}
                            variant="outline"
                            size="xs"
                            onClick={dismissal.retry}
                            data-testid="decisions-inbox-dismiss-retry"
                          >
                            Retry
                          </Button>
                        )
                      ) : dismissal.fallback !== null ? (
                        <Button
                          ref={cancelRef}
                          variant="ghost-danger"
                          size="xs"
                          onClick={cancel.askToWithdraw}
                          data-testid="decisions-inbox-withdraw"
                        >
                          Withdraw question
                        </Button>
                      ) : (
                        <Button
                          ref={cancelRef}
                          variant="ghost-danger"
                          size="xs"
                          onClick={cancel.ask}
                          data-testid="decisions-inbox-dismiss"
                        >
                          Dismiss question
                        </Button>
                      ))}
                  </div>
                </div>
                {reader.cancellable && dismissNote !== null && (
                  <p
                    role={dismissNote.live ? "status" : undefined}
                    className="text-xs text-text-secondary [text-wrap:pretty]"
                    data-testid="decisions-inbox-dismiss-status"
                  >
                    {dismissNote.text}
                  </p>
                )}
                <DecisionQuestionReadView reader={reader} target={shownTarget} active={isOpen} />
              </div>
            )}
          </section>
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
    </>
  );
}
