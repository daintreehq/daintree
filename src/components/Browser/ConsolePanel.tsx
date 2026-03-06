import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Trash2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useConsoleCaptureStore,
  type ConsoleLevel,
  EMPTY_MESSAGES,
} from "@/store/consoleCaptureStore";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface ConsolePanelProps {
  paneId: string;
  height?: number;
}

type LevelFilter = ConsoleLevel | "all";

const LEVEL_STYLES: Record<ConsoleLevel, { row: string; badge: string; label: string }> = {
  log: {
    row: "text-canopy-text/80",
    badge: "text-canopy-text/50 bg-canopy-text/10",
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

export function ConsolePanel({ paneId, height = 200 }: ConsolePanelProps) {
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [isAtBottom, setIsAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track the last visible message ID to correctly trigger scroll even when
  // filtered.length doesn't change (e.g. at 500-message buffer cap)
  const prevLastIdRef = useRef<number | null>(null);

  // Use stable empty array to avoid unnecessary rerenders when pane has no messages
  const allMessages = useConsoleCaptureStore(
    (state) => state.messages.get(paneId) ?? EMPTY_MESSAGES
  );
  const clearMessages = useConsoleCaptureStore((state) => state.clearMessages);

  const filtered = useMemo(() => {
    return allMessages.filter((msg) => {
      if (levelFilter !== "all") {
        if (levelFilter === "warning" && msg.level !== "warning") return false;
        if (levelFilter === "error" && msg.level !== "error") return false;
        // "log" filter: show log and info (non-warning/non-error output)
        if (levelFilter === "log" && msg.level !== "log" && msg.level !== "info") return false;
      }
      if (search) {
        return msg.message.toLowerCase().includes(search.toLowerCase());
      }
      return true;
    });
  }, [allMessages, levelFilter, search]);

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

  // Auto-scroll: track last visible message ID so we also scroll when a new
  // message arrives after the 500-msg buffer is full (length stays the same)
  const lastVisibleId = filtered.length > 0 ? filtered[filtered.length - 1].id : null;
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

  const buttonClass =
    "px-2 py-0.5 rounded text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/50";

  return (
    <div className="flex flex-col border-t border-overlay bg-canopy-bg" style={{ height }}>
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-overlay bg-surface shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-canopy-text/50 mr-1">
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
                  ? "bg-white/15 text-canopy-text"
                  : "text-canopy-text/50 hover:bg-white/8 hover:text-canopy-text/70"
              )}
            >
              {label}
              {filter === "error" && errorCount > 0 && (
                <span className="ml-1 text-status-error">{errorCount}</span>
              )}
              {filter === "warning" && warnCount > 0 && (
                <span className="ml-1 text-status-warning">{warnCount}</span>
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
          className="flex-1 min-w-0 max-w-[160px] px-2 py-0.5 text-[11px] rounded bg-canopy-bg border border-overlay focus:outline-none focus:border-white/20 text-canopy-text placeholder:text-canopy-text/30"
        />

        <div className="flex-1" />

        {/* Scroll to bottom */}
        {!isAtBottom && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleScrollToBottom}
                  className="p-1 rounded hover:bg-white/10 text-canopy-text/50 hover:text-canopy-text transition-colors"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Scroll to bottom</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {/* Clear */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => clearMessages(paneId)}
                className="p-1 rounded hover:bg-white/10 text-canopy-text/50 hover:text-canopy-text transition-colors"
                aria-label="Clear console"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Clear console</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed"
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-canopy-text/30 text-xs select-none">
            {allMessages.length === 0 ? "No console output" : "No messages match filter"}
          </div>
        ) : (
          filtered.map((msg) => {
            const style = LEVEL_STYLES[msg.level];
            return (
              <div
                key={msg.id}
                className={cn(
                  "flex items-start gap-2 px-2 py-0.5 border-b border-overlay/30 hover:bg-white/3",
                  style.row
                )}
              >
                <span className="shrink-0 text-canopy-text/30 select-none tabular-nums">
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
                <span className="min-w-0 break-all whitespace-pre-wrap">{msg.message}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
