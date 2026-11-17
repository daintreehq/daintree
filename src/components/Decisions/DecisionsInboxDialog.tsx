import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DecisionsIcon, TriangleAlert } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
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
import { DecisionQuestionReadView } from "./DecisionQuestionReader";
import { aliasLabel } from "./decisionQuestionModel";
import { referencedQuestion, type DecisionQuestionTarget } from "./decisionQuestionTarget";
import {
  agentName,
  connectionNotice,
  emptyText,
  inboxGroups,
  isAttention,
  originText,
  referenceKey,
  resolveSelection,
  standingText,
  worktreeName,
  type InboxChoice,
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

type ListRead =
  { state: "loading" } | { state: "failed" } | { state: "listed"; list: DecisionQuestionList };

const NO_LINES: ReadonlyMap<string, string | null> = new Map();
const NO_WORKTREES = new Map<string, WorktreeSnapshot>();

/** This computer's questions while the inbox is open and Decisions is on; `retry` watches afresh. */
function useQuestionList(active: boolean): { read: ListRead; retry: () => void } {
  const [read, setRead] = useState<ListRead>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    return decisionsClient.watchQuestions(
      (list) => setRead({ state: "listed", list }),
      () => setRead({ state: "failed" })
    );
  }, [active, attempt]);
  const retry = useCallback(() => {
    setRead({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { read, retry };
}

/** Decisions' status while the inbox is open, for what it says about the relay. */
function useInboxStatus(active: boolean): DecisionsStatus | null {
  const [status, setStatus] = useState<DecisionsStatus | null>(null);
  useEffect(() => {
    if (!active) return;
    return decisionsClient.watchStatus(setStatus);
  }, [active]);
  return active ? status : null;
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

  useEffect(() => {
    if (!active) {
      // Anything still on its way belongs to the opening that ended.
      opening.current += 1;
      asked.current = new Set();
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
  }, [active, items]);

  const release = useCallback(() => setLines(NO_LINES), []);
  return { lines, release };
}

/** Where the terminal that asked can be gone to: in this view, or in another project's. */
type TerminalReach = "here" | "elsewhere" | null;

/**
 * Whether the terminal that asked the question is still open on this
 * computer. This view's own panels answer for this project; for another, the
 * terminals this computer runs. A Remote Host window's terminals are another
 * computer's, so from one it offers nothing.
 */
function useTerminalReach(item: DecisionQuestionListItem | null, active: boolean): TerminalReach {
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

  useEffect(() => {
    if (!active || remote || here || key === null || terminalId === null || projectId === null) {
      return;
    }
    let live = true;
    terminalClient.getAll().then(
      (terminals) => {
        if (!live) return;
        const open = terminals.some(
          (terminal) =>
            terminal.id === terminalId &&
            terminal.projectId === projectId &&
            terminal.isTrashed !== true &&
            terminal.hasPty !== false
        );
        setFound({ key, open });
      },
      () => {
        if (live) setFound({ key, open: false });
      }
    );
    return () => {
      live = false;
    };
  }, [active, remote, here, key, terminalId, projectId]);

  if (item === null || remote) return null;
  if (here) return openHere ? "here" : null;
  return found !== null && found.key === key && found.open ? "elsewhere" : null;
}

function ListSkeleton() {
  return (
    <Skeleton label="Loading questions" className="flex flex-col gap-3 px-3 py-3">
      <SkeletonBone className="h-3 w-1/3" />
      <SkeletonBone className="h-9 w-full" />
      <SkeletonBone className="h-9 w-full" />
      <SkeletonBone className="h-9 w-4/5" />
    </Skeleton>
  );
}

function InboxRow({
  item,
  line,
  origin,
  selected,
  tabStop,
  rowRef,
  onFocus,
  onSelect,
}: {
  item: DecisionQuestionListItem;
  line: string | null;
  origin: string;
  selected: boolean;
  tabStop: boolean;
  rowRef: (element: HTMLElement | null) => void;
  onFocus: () => void;
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
        data-selected={selected ? "true" : undefined}
        onFocus={onFocus}
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
        <span className="w-full truncate text-2xs text-text-secondary">{origin}</span>
      </button>
    </li>
  );
}

/**
 * Every question this computer's Decisions holds (#17231), across its
 * projects and terminals, grouped by what it needs: the person, delivery, or
 * a decision about a stopped delivery, then history. Selecting one reads it
 * in full beside the list, with the question view's answer and cancel, and
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

  const { read: listRead, retry } = useQuestionList(active);
  const status = useInboxStatus(active);
  const notice = connectionNotice(status);
  const questions = listRead.state === "listed" ? listRead.list.questions : null;
  const groups = questions === null ? [] : inboxGroups(questions);
  const ordered = groups.flatMap((group) => group.items);
  const { lines, release: releaseLines } = useQuestionLines(ordered, active);

  const projects = useProjectStore((state) => state.projects);
  const worktrees = useWorktreeStoreOptional((state) => state.worktrees, NO_WORKTREES);
  const viewWorkspace = getViewWorkspaceId();
  const originOf = (item: DecisionQuestionListItem): string => {
    const project =
      projects.find((candidate) => candidate.id === item.reference.projectId)?.name ??
      item.projectLabel;
    // Only this view's project knows its worktrees by name.
    const known =
      item.reference.projectId === viewWorkspace
        ? (worktreeDisplayName(worktrees.get(item.worktreeId)) ?? null)
        : null;
    return originText({
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
  const reach = useTerminalReach(selected, active);

  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const keys = ordered.map((item) => referenceKey(item.reference));
  const roving = useRovingRows({ keys, preferredKey: selectedKey, containerRef: listRef });
  const detailHeadingId = useId();
  const listLabelId = useId();

  // Where the person went from here: the close leaves focus to the terminal.
  const [handoff, setHandoff] = useState<{
    terminalId: string;
    projectId: string;
    reach: "here" | "elsewhere";
  } | null>(null);

  // Opened before the list had loaded, focus waits on the dialog's surface; it
  // goes to the question shown once there is one, unless the person already
  // moved it to a control of their own.
  const focusedOpening = useRef(-1);
  useEffect(() => {
    const list = listRef.current;
    if (!isOpen || selectedKey === null || list === null) return;
    if (focusedOpening.current === request.seq) return;
    focusedOpening.current = request.seq;
    const focused = document.activeElement;
    // The surface, or nothing at all, holds the list rather than sitting in it.
    if (!(focused instanceof HTMLElement) || !focused.contains(list)) return;
    list.querySelector<HTMLElement>('[data-testid="decisions-inbox-row"][tabindex="0"]')?.focus();
  }, [isOpen, selectedKey, request.seq]);

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

  const goToTerminal = () => {
    if (selected === null || reach === null) return;
    setHandoff({
      terminalId: selected.reference.terminalId,
      projectId: selected.reference.projectId,
      reach,
    });
    close();
  };

  const onCloseComplete = (restoreSkipped?: () => void) => {
    // Content is never kept past the close.
    reader.release();
    releaseLines();
    const going = handoff;
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
  const empty = listRead.state === "listed" ? emptyText(groups) : null;
  const flatIndex = new Map(keys.map((key, index) => [key, index]));

  return (
    <>
      <AppDialog
        isOpen={isOpen}
        onClose={close}
        size="7xl"
        maxHeight="max-h-[min(52rem,88vh)]"
        className="h-[min(52rem,88vh)]"
        initialFocus="first"
        restoreFocusTo={restoreFocusTo}
        restoreFocusOnClose={handoff === null}
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
            ref={listRef}
            onKeyDown={roving.onKeyDown}
            tabIndex={roving.containerProps.tabIndex}
            onFocus={roving.containerProps.onFocus}
            onBlur={roving.containerProps.onBlur}
            className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto overscroll-contain border-r border-divider px-2 py-3 lg:w-80"
            aria-labelledby={listLabelId}
            role="region"
            data-testid="decisions-inbox-list"
          >
            <span id={listLabelId} className="sr-only">
              Questions
            </span>
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
            {groups.map((group) => {
              const headingId = `${listLabelId}-${group.id}`;
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
                          line={lines.get(key) ?? null}
                          origin={originOf(item)}
                          selected={key === selectedKey}
                          tabStop={key === roving.tabStopKey}
                          rowRef={roving.rowRef(key)}
                          onFocus={() => roving.onRowFocus(key)}
                          onSelect={() =>
                            setChoice({
                              seq: request.seq,
                              key,
                              index: flatIndex.get(key) ?? 0,
                            })
                          }
                        />
                      );
                    })}
                  </ul>
                </section>
              );
            })}
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
                    <p className="truncate text-xs text-text-secondary">{originOf(selected)}</p>
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
                    {reader.cancellable && (
                      <Button
                        ref={cancelRef}
                        variant="ghost-danger"
                        size="xs"
                        onClick={cancel.ask}
                        data-testid="decisions-inbox-cancel"
                      >
                        Cancel question
                      </Button>
                    )}
                  </div>
                </div>
                <DecisionQuestionReadView reader={reader} target={shownTarget} active={isOpen} />
              </div>
            )}
          </section>
        </div>
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
