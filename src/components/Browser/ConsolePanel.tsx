import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Trash2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useConsoleCaptureStore,
  type ConsoleLevel,
  type ConsoleMessage,
  EMPTY_MESSAGES,
} from "@/store/consoleCaptureStore";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ObjectInspector } from "./ObjectInspector";
import { StackTrace } from "./StackTrace";

interface ConsolePanelProps {
  paneId: string;
  height?: number;
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

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

// Group types that act as headers
const GROUP_HEADER_TYPES = new Set(["startGroup", "startGroupCollapsed"]);

function ConsoleRow({
  msg,
  webContentsId,
  isGroupCollapsed,
  onToggleGroup,
}: {
  msg: ConsoleMessage;
  webContentsId?: number;
  isGroupCollapsed?: boolean;
  onToggleGroup?: () => void;
}) {
  const style = LEVEL_STYLES[msg.level];
  const isGroupHeader = GROUP_HEADER_TYPES.has(msg.cdpType);
  const indentPx = msg.groupDepth * 12;

  return (
    <div
      className={cn(
        "flex items-start gap-2 px-2 py-0.5 border-b border-overlay/30 hover:bg-overlay-subtle",
        style.row
      )}
      style={indentPx > 0 ? { paddingLeft: `${8 + indentPx}px` } : undefined}
    >
      <span className="shrink-0 text-daintree-text/30 select-none tabular-nums">
        {formatTime(msg.timestamp)}
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
          {isGroupHeader && onToggleGroup && (
            <button
              type="button"
              onClick={onToggleGroup}
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
}

export function ConsolePanel({ paneId, height = 200, webContentsId }: ConsolePanelProps) {
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLastIdRef = useRef<number | null>(null);

  const allMessages = useConsoleCaptureStore(
    (state) => state.messages.get(paneId) ?? EMPTY_MESSAGES
  );
  const clearMessages = useConsoleCaptureStore((state) => state.clearMessages);

  // Apply level and search filters, then handle group collapsing
  const filtered = useMemo(() => {
    // First pass: filter by level and search
    let result = allMessages.filter((msg) => {
      // Always show group headers regardless of level filter
      if (GROUP_HEADER_TYPES.has(msg.cdpType)) return true;

      if (levelFilter !== "all") {
        if (levelFilter === "warning" && msg.level !== "warning") return false;
        if (levelFilter === "error" && msg.level !== "error") return false;
        if (levelFilter === "log" && msg.level !== "log" && msg.level !== "info") return false;
      }
      if (search) {
        return msg.summaryText.toLowerCase().includes(search.toLowerCase());
      }
      return true;
    });

    // Second pass: hide children of collapsed groups
    if (collapsedGroups.size > 0) {
      const hidden = new Set<number>();
      let skipDepth: number | null = null;

      result = result.filter((msg) => {
        if (skipDepth !== null) {
          if (msg.groupDepth > skipDepth) return false;
          skipDepth = null;
        }

        if (GROUP_HEADER_TYPES.has(msg.cdpType) && collapsedGroups.has(msg.id)) {
          skipDepth = msg.groupDepth;
          return true; // Show the header, hide children
        }

        return !hidden.has(msg.id);
      });
    }

    return result;
  }, [allMessages, levelFilter, search, collapsedGroups]);

  // Auto-collapse startGroupCollapsed entries
  useEffect(() => {
    const newCollapsed = new Set<number>();
    for (const msg of allMessages) {
      if (msg.cdpType === "startGroupCollapsed") {
        newCollapsed.add(msg.id);
      }
    }
    if (newCollapsed.size > 0) {
      setCollapsedGroups((prev) => {
        const merged = new Set(prev);
        let changed = false;
        for (const id of newCollapsed) {
          if (!merged.has(id)) {
            merged.add(id);
            changed = true;
          }
        }
        return changed ? merged : prev;
      });
    }
  }, [allMessages]);

  const errorCount = useMemo(
    () => allMessages.filter((m) => m.level === "error").length,
    [allMessages]
  );
  const warnCount = useMemo(
    () => allMessages.filter((m) => m.level === "warning").length,
    [allMessages]
  );

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
    "px-2 py-0.5 rounded text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-daintree-accent/50";

  return (
    <div className="flex flex-col border-t border-overlay bg-daintree-bg" style={{ height }}>
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
          className="flex-1 min-w-0 max-w-[160px] px-2 py-0.5 text-[11px] rounded bg-daintree-bg border border-overlay focus:outline-none focus:border-border-strong text-daintree-text placeholder:text-daintree-text/30"
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
              onClick={() => clearMessages(paneId)}
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
              onToggleGroup={
                GROUP_HEADER_TYPES.has(msg.cdpType) ? () => toggleGroup(msg.id) : undefined
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
