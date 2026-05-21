import { memo, useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Trash2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useConsoleCaptureStore,
  type ConsoleLevel,
  type ConsoleMessage,
  EMPTY_MESSAGES,
  ZERO_COUNTS,
} from "@/store/consoleCaptureStore";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { ObjectInspector } from "./ObjectInspector";
import { StackTrace } from "./StackTrace";

interface ConsolePanelProps {
  paneId: string;
  webContentsId?: number;
}

type LevelFilter = ConsoleLevel | "all";

const LEVEL_STYLES: Record<ConsoleLevel, { row: string; badge: string; label: string }> = {
  log: {
    row: "text-daintree-text/80",
    badge: "text-daintree-text/50 bg-daintree-text/10",
    label: "LOG",
  },
  info: {
    row: "text-status-info",
    badge: "text-status-info bg-status-info/15",
    label: "INF",
  },
  warning: {
    row: "text-status-warning",
    badge: "text-status-warning bg-status-warning/15",
    label: "WRN",
  },
  error: {
    row: "text-status-error",
    badge: "text-status-error bg-status-error/15",
    label: "ERR",
  },
};

const FILTER_BUTTONS: { filter: LevelFilter; label: string }[] = [
  { filter: "all", label: "All" },
  { filter: "error", label: "Errors" },
  { filter: "warning", label: "Warn" },
  { filter: "log", label: "Log" },
];

const ConsoleRow = memo(function ConsoleRow({
  msg,
  webContentsId,
  isGroupCollapsed,
  onToggleGroup,
}: {
  msg: ConsoleMessage;
  webContentsId?: number;
  isGroupCollapsed?: boolean;
  onToggleGroup?: (msgId: number) => void;
}) {
  const style = LEVEL_STYLES[msg.level];
  const indentPx = msg.groupDepth * 12;
  const handleToggle = useCallback(() => onToggleGroup?.(msg.id), [onToggleGroup, msg.id]);

  return (
    <div
      className={cn(
        "flex items-start gap-2 px-2 py-0.5 border-b border-overlay/30 hover:bg-overlay-subtle",
        style.row
      )}
      style={indentPx > 0 ? { paddingLeft: `${8 + indentPx}px` } : undefined}
    >
      <span className="shrink-0 text-daintree-text/30 select-none tabular-nums">
        {msg.timeLabel}
      </span>
      <span
        className={cn(
          "shrink-0 text-[9px] font-bold tracking-wide px-1 py-0.5 rounded select-none",
          style.badge
        )}
      >
        {style.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-all whitespace-pre-wrap select-text">
          {msg.isGroupHeader && onToggleGroup && (
            <button
              type="button"
              onClick={handleToggle}
              className="text-daintree-text/40 mr-1 select-none hover:text-daintree-text/60"
            >
              {isGroupCollapsed ? "▶" : "▼"}
            </button>
          )}
          {msg.args.length > 0 ? (
            msg.args.map((arg, i) => (
              <span key={i}>
                {i > 0 && <span className="mx-1" />}
                <ObjectInspector arg={arg} webContentsId={webContentsId} isStale={msg.isStale} />
              </span>
            ))
          ) : (
            <span className="text-daintree-text/50">{msg.summaryText}</span>
          )}
        </div>
        {msg.stackTrace && <StackTrace stackTrace={msg.stackTrace} />}
      </div>
    </div>
  );
});

export function ConsolePanel({ paneId, webContentsId }: ConsolePanelProps) {
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLastIdRef = useRef<number | null>(null);
  const lastSeenTailIdRef = useRef<number | null>(null);

  const allMessages = useConsoleCaptureStore(
    (state) => state.messages.get(paneId) ?? EMPTY_MESSAGES
  );
  const counts = useConsoleCaptureStore((state) => state.counters.get(paneId) ?? ZERO_COUNTS);
  const clearMessages = useConsoleCaptureStore((state) => state.clearMessages);

  const handleClear = useCallback(() => {
    clearMessages(paneId);
    // Also release the CDP-retained remote object references for this pane so
    // long-lived sessions with heavy object logging don't leak main-process
    // memory. Best-effort: the renderer-side clear is the user-visible action.
    if (webContentsId != null) {
      safeFireAndForget(window.electron.webview.clearConsoleCapture(webContentsId, paneId), {
        context: "Clearing dev-preview console capture",
      });
    }
  }, [clearMessages, paneId, webContentsId]);

  // Apply level and search filters, then handle group collapsing
  const filtered = useMemo(() => {
    const lowerSearch = search ? search.toLowerCase() : "";

    // First pass: filter by level and search
    let result = allMessages.filter((msg) => {
      // Always show group headers regardless of level filter
      if (msg.isGroupHeader) return true;

      if (levelFilter !== "all") {
        if (levelFilter === "warning" && msg.level !== "warning") return false;
        if (levelFilter === "error" && msg.level !== "error") return false;
        if (levelFilter === "log" && msg.level !== "log" && msg.level !== "info") return false;
      }
      if (lowerSearch) {
        return msg.summaryText.toLowerCase().includes(lowerSearch);
      }
      return true;
    });

    // Second pass: hide children of collapsed groups
    if (collapsedGroups.size > 0) {
      let skipDepth: number | null = null;

      result = result.filter((msg) => {
        if (skipDepth !== null) {
          if (msg.groupDepth > skipDepth) return false;
          skipDepth = null;
        }

        if (msg.isGroupHeader && collapsedGroups.has(msg.id)) {
          skipDepth = msg.groupDepth;
          return true; // Show the header, hide children
        }

        return true;
      });
    }

    return result;
  }, [allMessages, levelFilter, search, collapsedGroups]);

  // Reset auto-collapse tracking when the pane changes
  useEffect(() => {
    lastSeenTailIdRef.current = null;
    setCollapsedGroups(new Set());
  }, [paneId]);

  // Auto-collapse startGroupCollapsed entries — scan only newly-arrived messages.
  // Track the last-seen tail message id (not array index) so the cursor survives
  // 500-cap eviction, where the array length stays the same but new ids land at the end.
  useEffect(() => {
    if (allMessages.length === 0) {
      lastSeenTailIdRef.current = null;
      // Drop any stale collapsed-group ids from the prior session
      setCollapsedGroups((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }

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

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 8;
    setIsAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - threshold);
  }, []);

  const lastVisibleId = filtered.length > 0 ? filtered[filtered.length - 1]!.id : null;
  useEffect(() => {
    if (lastVisibleId === prevLastIdRef.current) return;
    prevLastIdRef.current = lastVisibleId;
    if (isAtBottom) {
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [lastVisibleId, isAtBottom]);

  const handleScrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setIsAtBottom(true);
    }
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

  const buttonClass =
    "px-2 py-0.5 rounded text-[10px] font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent/50";

  return (
    <div className="flex h-full flex-col bg-daintree-bg">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-overlay bg-surface shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-daintree-text/50 mr-1">
          Console
        </span>

        {/* Level filters */}
        <div className="flex items-center gap-0.5">
          {FILTER_BUTTONS.map(({ filter, label }) => (
            <button
              key={filter}
              type="button"
              onClick={() => setLevelFilter(filter)}
              className={cn(
                buttonClass,
                levelFilter === filter
                  ? "bg-overlay-emphasis text-daintree-text"
                  : "text-daintree-text/50 hover:bg-overlay-soft hover:text-daintree-text/70"
              )}
            >
              {label}
              {filter === "error" && errorCount > 0 && (
                <span className="ml-1 tabular-nums text-status-error">{errorCount}</span>
              )}
              {filter === "warning" && warnCount > 0 && (
                <span className="ml-1 tabular-nums text-status-warning">{warnCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter…"
          className="flex-1 min-w-0 max-w-[160px] px-2 py-0.5 text-[11px] rounded bg-daintree-bg border border-overlay focus:outline-hidden focus:border-border-strong text-daintree-text placeholder:text-daintree-text/30"
        />

        <div className="flex-1" />

        {/* Scroll to bottom */}
        {!isAtBottom && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleScrollToBottom}
                className="p-1 rounded hover:bg-overlay-medium text-daintree-text/50 hover:text-daintree-text transition-colors"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Scroll to bottom</TooltipContent>
          </Tooltip>
        )}

        {/* Clear */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleClear}
              className="p-1 rounded hover:bg-overlay-medium text-daintree-text/50 hover:text-daintree-text transition-colors"
              aria-label="Clear console"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Clear console</TooltipContent>
        </Tooltip>
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed"
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-daintree-text/30 text-xs select-none">
            {allMessages.length === 0 ? "No console output" : "No messages match filter"}
          </div>
        ) : (
          filtered.map((msg) => (
            <ConsoleRow
              key={msg.id}
              msg={msg}
              webContentsId={webContentsId}
              isGroupCollapsed={collapsedGroups.has(msg.id)}
              onToggleGroup={msg.isGroupHeader ? toggleGroup : undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}
