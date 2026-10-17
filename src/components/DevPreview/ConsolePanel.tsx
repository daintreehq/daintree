import { memo, useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Check, ChevronDown, Copy, Trash2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useConsoleCaptureStore,
  type ConsoleLevel,
  type ConsoleMessage,
  EMPTY_MESSAGES,
  ZERO_COUNTS,
} from "@/store/consoleCaptureStore";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { COPY_FAILED_LABEL, CopyButton } from "@/components/ui/CopyButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollPill } from "@/components/ui/ScrollPill";
import { SearchField } from "@/components/ui/SearchField";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { pluralize } from "@/lib/pluralize";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { sanitizeForClipboard } from "@/lib/clipboardSanitize";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { ObjectInspector, ObjectViewCacheContext, type ObjectViewCache } from "./ObjectInspector";
import { HighlightedText, substringMatchIndices } from "@/components/ui/HighlightedText";
import { DisclosureChevron } from "./DisclosureChevron";
import { DISCLOSURE_TOGGLE_CLASS, StackLocation, StackTrace } from "./StackTrace";
import { stripV8StackTail } from "./stackFrames";
import { RowKeyboardFocusContext } from "./rowFocusTooltip";
import type { CdpRemoteArg } from "@shared/types/ipc/webviewConsole";

interface ConsolePanelProps {
  paneId: string;
  webContentsId?: number;
}

type LevelFilter = ConsoleLevel | "all";

/**
 * DevTools' encoding: a log row is plain, the louder levels carry the shared
 * severity glyph and a faint wash so they can be found by shape as well as by
 * colour. `label` is the abbreviation the copied text keeps.
 */
const LEVEL_STYLES: Record<
  ConsoleLevel,
  { label: string; name: string; Icon?: LucideIcon; iconClass?: string; row?: string }
> = {
  log: { label: "LOG", name: "Log" },
  info: {
    label: "INF",
    name: "Info",
    Icon: SEVERITY_GLYPH.info,
    iconClass: "text-text-secondary",
  },
  warning: {
    label: "WRN",
    name: "Warning",
    Icon: SEVERITY_GLYPH.warning,
    iconClass: "text-status-warning",
    row: "bg-status-warning/5",
  },
  error: {
    label: "ERR",
    name: "Error",
    Icon: SEVERITY_GLYPH.error,
    iconClass: "text-status-error",
    row: "bg-status-error/5",
  },
};

const FILTER_BUTTONS: { filter: LevelFilter; label: string; noun: string }[] = [
  { filter: "all", label: "All", noun: "messages" },
  { filter: "error", label: "Errors", noun: "errors" },
  { filter: "warning", label: "Warnings", noun: "warnings" },
  { filter: "log", label: "Logs", noun: "log messages" },
];

const MAX_QUERY_IN_TITLE = 40;

// Each line is sanitized individually — sanitizeForClipboard strips newlines
// along with the other C0 controls, so sanitizing the joined output would
// collapse the intentional row/frame line structure. Multi-line summaries
// (e.g. exception text with embedded frames) are split first so their line
// structure survives sanitization, matching the whitespace-pre-wrap display.
export function serializeConsoleMessage(msg: ConsoleMessage): string {
  const [firstLine = "", ...restLines] = displaySummary(msg).split("\n");
  const lines = [
    sanitizeForClipboard(`[${msg.timeLabel}] [${LEVEL_STYLES[msg.level].label}] ${firstLine}`),
    ...restLines.map((line) => sanitizeForClipboard(line)),
  ];
  if (msg.stackTrace) {
    for (const frame of msg.stackTrace.callFrames) {
      const name = frame.functionName || "(anonymous)";
      const location = frame.url ? ` (${frame.url}:${frame.lineNumber}:${frame.columnNumber})` : "";
      lines.push(sanitizeForClipboard(`  at ${name}${location}`));
    }
  }
  return lines.join("\n");
}

export function serializeConsoleMessages(messages: ConsoleMessage[]): string {
  return messages.map(serializeConsoleMessage).join("\n");
}

function hasFrames(msg: ConsoleMessage): boolean {
  return (msg.stackTrace?.callFrames.length ?? 0) > 0;
}

// An exception's text already ends in V8's rendering of the stack; when the
// structured frames came with it, they are the one copy that gets shown.
function displaySummary(msg: ConsoleMessage): string {
  return hasFrames(msg) ? stripV8StackTail(msg.summaryText) : msg.summaryText;
}

// DevTools' convention: every message names its source, but only the ones
// someone is likely to trace back offer the full stack. V8 attaches a stack
// to every console.log too, and a disclosure on each would double the list.
function offersStackTrace(msg: ConsoleMessage): boolean {
  return (
    hasFrames(msg) && (msg.level === "error" || msg.level === "warning" || msg.cdpType === "trace")
  );
}

interface StackView {
  expanded: boolean;
  openRuns: readonly number[];
}

const NO_OPEN_RUNS: readonly number[] = [];

// Held visible while the button confirms a copy, so the check is not lost
// when the pointer leaves the row.
const COPY_REVEAL_CLASS =
  "shrink-0 invisible opacity-0 pointer-events-none transition-[opacity,visibility] duration-150 delay-75 group-hover/row:visible group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-focus-within/row:visible group-focus-within/row:opacity-100 group-focus-within/row:pointer-events-auto has-[[data-copied]]:visible has-[[data-copied]]:opacity-100 motion-reduce:transition-none";

/**
 * A top-level string is the message itself, printed as written; quotes and
 * string colour are for values inside an inspected object (DevTools does the
 * same).
 */
function MessageArg({
  arg,
  index,
  webContentsId,
  msg,
  query,
}: {
  arg: CdpRemoteArg;
  index: number;
  webContentsId?: number;
  msg: ConsoleMessage;
  query: string;
}) {
  if (arg.type === "primitive" && arg.kind === "string") {
    return <Highlighted text={String(arg.value)} query={query} />;
  }
  return (
    <ObjectInspector
      arg={arg}
      webContentsId={webContentsId}
      paneId={msg.paneId}
      rowId={msg.id}
      isStale={msg.isStale}
      path={String(index)}
    />
  );
}

/** The text filter's match, marked in the message it matched. */
function Highlighted({ text, query }: { text: string; query: string }) {
  return <HighlightedText text={text} indices={substringMatchIndices(text, query)} />;
}

const ConsoleRow = memo(function ConsoleRow({
  msg,
  webContentsId,
  isGroupCollapsed,
  onToggleGroup,
  stackView,
  onStackViewChange,
  query,
}: {
  msg: ConsoleMessage;
  query: string;
  webContentsId?: number;
  isGroupCollapsed?: boolean;
  onToggleGroup?: (msgId: number) => void;
  stackView?: StackView;
  onStackViewChange?: (msgId: number, view: StackView) => void;
}) {
  const style = LEVEL_STYLES[msg.level];
  // One chevron and its gap, so a group's messages start under its label.
  const indentPx = msg.groupDepth * 16;
  const handleToggle = useCallback(() => onToggleGroup?.(msg.id), [onToggleGroup, msg.id]);
  const summary = displaySummary(msg);
  // An uncaught exception used to print its stack in the message text; it
  // opens with the frames showing so stripping that text hides nothing.
  const stackExpanded = stackView?.expanded ?? summary !== msg.summaryText;
  const openRuns = stackView?.openRuns ?? NO_OPEN_RUNS;
  const handleStackToggle = useCallback(
    () => onStackViewChange?.(msg.id, { expanded: !stackExpanded, openRuns }),
    [onStackViewChange, msg.id, stackExpanded, openRuns]
  );
  const handleRunToggle = useCallback(
    (start: number) =>
      onStackViewChange?.(msg.id, {
        expanded: stackExpanded,
        openRuns: openRuns.includes(start)
          ? openRuns.filter((s) => s !== start)
          : [...openRuns, start],
      }),
    [onStackViewChange, msg.id, stackExpanded, openRuns]
  );
  const copyText = useCallback(() => serializeConsoleMessage(msg), [msg]);
  const { Icon } = style;
  // The row owns the keyboard, so the tooltips inside it open with the row's
  // keyboard focus instead of adding tab stops of their own.
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);

  return (
    <RowKeyboardFocusContext value={isKeyboardFocused}>
      {/* tabIndex makes the row itself focusable so keyboard users can reach the
        focus-within-revealed copy button on rows with no other focusable child. */}
      <div
        tabIndex={0}
        data-console-row={msg.id}
        onFocus={(e) => {
          if (e.target === e.currentTarget) {
            setIsKeyboardFocused(e.currentTarget.matches(":focus-visible"));
          }
        }}
        onBlur={(e) => {
          if (e.target === e.currentTarget) setIsKeyboardFocused(false);
        }}
        className={cn(
          "group/row flex items-start gap-2 px-2 py-0.5 border-b border-overlay/30 text-text-primary hover:bg-overlay-subtle focus-visible:-outline-offset-2",
          style.row
        )}
      >
        {/* A narrow pane gives the time column's width to the message; the time
          moves to the source line instead. */}
        <span className="shrink-0 text-text-secondary select-none tabular-nums @max-[30rem]/console:hidden">
          {msg.timeLabel}
        </span>
        {/* One line tall, so the glyph sits on the message's first line. */}
        <span className="flex h-[1.625em] w-3 shrink-0 items-center justify-center select-none">
          {Icon && <Icon aria-hidden="true" className={cn("size-3", style.iconClass)} />}
          {msg.level !== "log" && <span className="sr-only">{style.name}:</span>}
        </span>
        {/* Nesting moves the message, never the time column. */}
        <div
          className="min-w-0 flex-1"
          style={indentPx > 0 ? { paddingLeft: `${indentPx}px` } : undefined}
        >
          {/* The source sits at the line's end when there is room and drops
            beneath the message in a narrow pane rather than squeezing it. */}
          <div className="flex flex-wrap items-baseline gap-x-3">
            <div className="min-w-0 flex-auto wrap-break-word whitespace-pre-wrap select-text">
              {msg.isGroupHeader ? (
                onToggleGroup ? (
                  <button
                    type="button"
                    onClick={handleToggle}
                    aria-expanded={!isGroupCollapsed}
                    className={cn(
                      DISCLOSURE_TOGGLE_CLASS,
                      // The negative margin keeps the 24px target inside the
                      // row's line height, so the time column stays aligned.
                      "-my-1 min-h-6 font-semibold text-text-primary whitespace-pre-wrap"
                    )}
                  >
                    <DisclosureChevron expanded={!isGroupCollapsed} />
                    {summary}
                  </button>
                ) : (
                  <span className="font-semibold">
                    <Highlighted text={summary} query={query} />
                  </span>
                )
              ) : msg.args.length > 0 ? (
                msg.args.map((arg, i) => (
                  <span key={i}>
                    {i > 0 && " "}
                    <MessageArg
                      arg={arg}
                      index={i}
                      webContentsId={webContentsId}
                      msg={msg}
                      query={query}
                    />
                  </span>
                ))
              ) : (
                <Highlighted text={summary} query={query} />
              )}
            </div>
            <span className="ml-auto flex min-w-0 max-w-full gap-3">
              <span className="hidden shrink-0 text-text-secondary select-none tabular-nums @max-[30rem]/console:inline">
                {msg.timeLabel}
              </span>
              {msg.stackTrace && <StackLocation stackTrace={msg.stackTrace} />}
            </span>
          </div>
          {offersStackTrace(msg) && (
            <StackTrace
              stackTrace={msg.stackTrace!}
              expanded={stackExpanded}
              openRuns={openRuns}
              onToggle={handleStackToggle}
              onToggleRun={handleRunToggle}
            />
          )}
        </div>
        <div className={COPY_REVEAL_CLASS}>
          {/* Pulled back into the row's line height by the negative margin so
            revealing the 24px target never grows the row. */}
          <CopyButton
            text={copyText}
            aria-label="Copy console message"
            tooltip="Copy message"
            tooltipSide="left"
            className="-my-1"
          />
        </div>
      </div>
    </RowKeyboardFocusContext>
  );
});

function truncateQuery(query: string): string {
  return query.length > MAX_QUERY_IN_TITLE ? `${query.slice(0, MAX_QUERY_IN_TITLE)}…` : query;
}

export function ConsolePanel({ paneId, webContentsId }: ConsolePanelProps) {
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [wasCleared, setWasCleared] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set());
  // Held here rather than in each row: the list is virtualized, so a row
  // scrolled out of view unmounts and would forget what was opened.
  const [stackViews, setStackViews] = useState<Map<number, StackView>>(() => new Map());
  // Mutated in place by the inspectors; nothing renders from it directly.
  const [objectViews] = useState<ObjectViewCache>(() => new Map());
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastSeenTailIdRef = useRef<number | null>(null);

  const allMessages = useConsoleCaptureStore(
    (state) => state.messages.get(paneId) ?? EMPTY_MESSAGES
  );
  const counts = useConsoleCaptureStore((state) => state.counters.get(paneId) ?? ZERO_COUNTS);
  const clearMessages = useConsoleCaptureStore((state) => state.clearMessages);

  const handleClear = useCallback(() => {
    clearMessages(paneId);
    objectViews.clear();
    setWasCleared(true);
    // Also release the CDP-retained remote object references for this pane so
    // long-lived sessions with heavy object logging don't leak main-process
    // memory. Best-effort: the renderer-side clear is the user-visible action.
    if (webContentsId != null) {
      safeFireAndForget(window.electron.webview.clearConsoleCapture(webContentsId, paneId), {
        context: "Clearing dev-preview console capture",
      });
    }
  }, [clearMessages, objectViews, paneId, webContentsId]);

  const isFiltering = levelFilter !== "all" || search !== "";

  const { filtered, hiddenCount } = useMemo(() => {
    if (!isFiltering) {
      if (collapsedGroups.size === 0) return { filtered: allMessages, hiddenCount: 0 };
      // Hide the children of collapsed groups.
      let skipDepth: number | null = null;
      const folded = allMessages.filter((msg) => {
        if (skipDepth !== null) {
          if (msg.groupDepth > skipDepth) return false;
          skipDepth = null;
        }
        if (msg.isGroupHeader && collapsedGroups.has(msg.id)) skipDepth = msg.groupDepth;
        return true;
      });
      return { filtered: folded, hiddenCount: 0 };
    }

    const lowerSearch = search.toLowerCase();
    const matchesSearch = (msg: ConsoleMessage) =>
      !lowerSearch || msg.summaryText.toLowerCase().includes(lowerSearch);
    const matchesLevel = (msg: ConsoleMessage) =>
      levelFilter === "all" ||
      msg.level === levelFilter ||
      (levelFilter === "log" && msg.level === "info");

    // A filter answers "where is it?", so folds give way while one is set: a
    // match inside a collapsed group still shows, under the headers that
    // contain it, and headers with nothing matching drop out. The folds come
    // back as they were once the filter clears.
    const result: ConsoleMessage[] = [];
    const openHeaders: { msg: ConsoleMessage; shown: boolean }[] = [];
    const showOpenHeaders = () => {
      for (const header of openHeaders) {
        if (header.shown) continue;
        result.push(header.msg);
        header.shown = true;
      }
    };
    let total = 0;
    for (const msg of allMessages) {
      while (openHeaders.length > 0 && openHeaders.at(-1)!.msg.groupDepth >= msg.groupDepth) {
        openHeaders.pop();
      }
      if (msg.isGroupHeader) {
        openHeaders.push({ msg, shown: false });
        if (lowerSearch && matchesSearch(msg)) showOpenHeaders();
        continue;
      }
      total++;
      if (!matchesLevel(msg) || !matchesSearch(msg)) continue;
      showOpenHeaders();
      result.push(msg);
    }
    const shown = result.reduce((n, msg) => (msg.isGroupHeader ? n : n + 1), 0);
    return { filtered: result, hiddenCount: total - shown };
  }, [allMessages, isFiltering, levelFilter, search, collapsedGroups]);

  // Reset auto-collapse tracking when the pane changes
  useEffect(() => {
    lastSeenTailIdRef.current = null;
    setCollapsedGroups(new Set());
    setStackViews(new Map());
    objectViews.clear();
    setWasCleared(false);
  }, [paneId, objectViews]);

  // A row that leaves the buffer takes its opened objects with it.
  useEffect(() => {
    if (objectViews.size === 0) return;
    const live = new Set(allMessages.map((msg) => String(msg.id)));
    for (const key of objectViews.keys()) {
      if (!live.has(key.slice(0, key.indexOf(":")))) objectViews.delete(key);
    }
  }, [allMessages, objectViews]);

  // Auto-collapse startGroupCollapsed entries — scan only newly-arrived messages.
  // Track the last-seen tail message id (not array index) so the cursor survives
  // 500-cap eviction, where the array length stays the same but new ids land at the end.
  useEffect(() => {
    if (allMessages.length === 0) {
      lastSeenTailIdRef.current = null;
      // Drop any stale collapsed-group ids from the prior session
      setCollapsedGroups((prev) => (prev.size === 0 ? prev : new Set()));
      setStackViews((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    setWasCleared(false);

    const newTail = allMessages[allMessages.length - 1]!;
    if (newTail.id === lastSeenTailIdRef.current) return;

    const lastSeenTailId = lastSeenTailIdRef.current;
    let firstNewIdx = allMessages.length;
    if (lastSeenTailId === null) {
      firstNewIdx = 0;
    } else {
      while (firstNewIdx > 0 && allMessages[firstNewIdx - 1]!.id > lastSeenTailId) {
        firstNewIdx--;
      }
    }
    lastSeenTailIdRef.current = newTail.id;

    if (firstNewIdx >= allMessages.length) return;

    let newIds: number[] | null = null;
    for (let i = firstNewIdx; i < allMessages.length; i++) {
      const msg = allMessages[i]!;
      if (msg.cdpType === "startGroupCollapsed") {
        (newIds ??= []).push(msg.id);
      }
    }

    if (newIds === null) return;
    const ids = newIds;
    setCollapsedGroups((prev) => {
      const merged = new Set(prev);
      let changed = false;
      for (const id of ids) {
        if (!merged.has(id)) {
          merged.add(id);
          changed = true;
        }
      }
      return changed ? merged : prev;
    });
  }, [allMessages]);

  const { errorCount, warnCount } = counts;

  const lastRowId = filtered.at(-1)?.id;
  const handleScrollToBottom = useCallback(() => {
    // align "end" lands on the true bottom even when the last row is tall
    // (e.g. an expanded object or long stack trace).
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    setIsAtBottom(true);
    // The pill goes once the list is at the bottom; focus lands on the row it
    // jumped to rather than falling to the page.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector<HTMLElement>(`[data-console-row="${lastRowId}"]`)
          ?.focus({ preventScroll: true });
      })
    );
  }, [lastRowId]);

  const showJump = !isAtBottom && filtered.length > 0;
  const jumpPresence = useAnimatedPresence({ isOpen: showJump, animationDuration: 0 });

  const { copied: allCopied, copy: copyAll } = useCopyWithFeedback();
  const handleCopyVisible = useCallback(async () => {
    const ok = await copyAll(serializeConsoleMessages(filtered));
    if (!ok) useAnnouncerStore.getState().announce(COPY_FAILED_LABEL, "assertive");
  }, [copyAll, filtered]);

  const clearFilters = useCallback(() => {
    setLevelFilter("all");
    setSearch("");
    // The button goes with the empty state; the filter field is where the
    // next search starts.
    searchInputRef.current?.focus();
  }, []);

  const changeStackView = useCallback((msgId: number, view: StackView) => {
    setStackViews((prev) => new Map(prev).set(msgId, view));
  }, []);

  const toggleGroup = useCallback((msgId: number) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
      } else {
        next.add(msgId);
      }
      return next;
    });
  }, []);

  const levelOptions: SegmentedRadioOption<LevelFilter>[] = FILTER_BUTTONS.map(
    ({ filter, label }) => {
      const count = filter === "error" ? errorCount : filter === "warning" ? warnCount : 0;
      if (count === 0) return { value: filter, label };
      return {
        value: filter,
        label,
        ariaLabel: `${label}, ${pluralize(count, filter === "error" ? "error" : "warning")}`,
        trailing: (
          <span className={filter === "error" ? "text-status-error" : "text-status-warning"}>
            {count}
          </span>
        ),
      };
    }
  );

  const noun = FILTER_BUTTONS.find((b) => b.filter === levelFilter)!.noun;
  const trimmedSearch = search.trim();
  const noMatchTitle = trimmedSearch
    ? `No ${noun} match “${truncateQuery(trimmedSearch)}”`
    : `No ${noun}`;

  return (
    <div className="flex h-full flex-col bg-surface-canvas">
      {/* Toolbar. In a narrow pane the filter field and the actions wrap
          under the level filter together, so the actions stay on the right. */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 py-1 border-b border-overlay bg-surface shrink-0">
        <SegmentedRadioGroup
          options={levelOptions}
          value={levelFilter}
          onChange={setLevelFilter}
          aria-label="Console level"
          density="compact"
        />

        <div className="flex min-w-56 flex-1 items-center gap-1.5">
          <SearchField
            size="dense"
            fieldClassName="min-w-28 max-w-56 flex-1"
            inputRef={searchInputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch("")}
            clearLabel="Clear filter"
            placeholder="Filter…"
            aria-label="Filter console messages"
          />

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {hiddenCount > 0 && (
              <span className="whitespace-nowrap pr-1 text-xs tabular-nums text-text-secondary">
                {hiddenCount.toLocaleString()} hidden
              </span>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void handleCopyVisible()}
                  disabled={filtered.length === 0}
                  className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
                  aria-label="Copy visible console messages"
                >
                  {allCopied ? (
                    <Check aria-hidden="true" className={PANE_TOOLBAR_ICON_CLASS} />
                  ) : (
                    <Copy aria-hidden="true" className={PANE_TOOLBAR_ICON_CLASS} />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Copy visible messages</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={allMessages.length === 0}
                  className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
                  aria-label="Clear console"
                >
                  <Trash2 aria-hidden="true" className={PANE_TOOLBAR_ICON_CLASS} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Clear console</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Message list */}
      {filtered.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto">
          {allMessages.length > 0 ? (
            <EmptyState
              variant="filtered-empty"
              scale="sidebar"
              instant
              title={noMatchTitle}
              action={
                <Button variant="subtle" size="sm" onClick={clearFilters}>
                  Show all messages
                </Button>
              }
            />
          ) : wasCleared ? (
            <EmptyState variant="user-cleared" scale="sidebar" title="Console cleared" />
          ) : (
            <EmptyState
              variant="zero-data"
              scale="sidebar"
              title="Use the preview to see its console messages here"
            />
          )}
        </div>
      ) : (
        <div ref={listRef} className="@container/console relative min-h-0 flex-1">
          <ObjectViewCacheContext value={objectViews}>
            <Virtuoso
              ref={virtuosoRef}
              data={filtered}
              computeItemKey={(_index, msg) => msg.id}
              // Opens on the newest message, as a console does, so the list is
              // following output from the start.
              initialTopMostItemIndex={{ index: "LAST", align: "end" }}
              followOutput={isAtBottom ? "auto" : false}
              atBottomStateChange={setIsAtBottom}
              itemContent={(_index, msg) => (
                <ConsoleRow
                  msg={msg}
                  webContentsId={webContentsId}
                  isGroupCollapsed={!isFiltering && collapsedGroups.has(msg.id)}
                  onToggleGroup={msg.isGroupHeader && !isFiltering ? toggleGroup : undefined}
                  stackView={stackViews.get(msg.id)}
                  onStackViewChange={changeStackView}
                  query={search}
                />
              )}
              className="h-full font-mono text-2xs leading-relaxed"
            />
          </ObjectViewCacheContext>
          {jumpPresence.shouldRender && (
            <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
              <ScrollPill
                isVisible={jumpPresence.isVisible}
                translateDirection="down"
                className="flex items-center gap-1 px-2 py-0.5 text-xs"
                onClick={handleScrollToBottom}
              >
                <ChevronDown aria-hidden="true" className="h-3 w-3" />
                Jump to latest
              </ScrollPill>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
