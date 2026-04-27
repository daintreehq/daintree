import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useLogsStore, filterLogs, collapseConsecutiveDuplicates } from "@/store";
import { LogEntry, type LogEntryCopyMeta } from "../Logs/LogEntry";
import { LogFilters } from "../Logs/LogFilters";
import type { LogEntry as LogEntryType, LogLevel } from "@/types";

import { logsClient, appClient } from "@/clients";

export interface LogsContentProps {
  className?: string;
  onSourcesChange?: (sources: string[]) => void;
}

const EMPTY_LEVEL_COUNTS: Record<LogLevel, number> = {
  debug: 0,
  info: 0,
  warn: 0,
  error: 0,
};

function extractElectronVersion(): string {
  try {
    const match = /Electron\/([\d.]+)/.exec(navigator.userAgent);
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function LogsContent({ className, onSourcesChange }: LogsContentProps) {
  const {
    logs,
    filters,
    autoScroll,
    expandedIds,
    addLogs,
    setLogs,
    setFilters,
    clearFilters,
    setAutoScroll,
    toggleExpanded,
  } = useLogsStore(
    useShallow((state) => ({
      logs: state.logs,
      filters: state.filters,
      autoScroll: state.autoScroll,
      expandedIds: state.expandedIds,
      addLogs: state.addLogs,
      setLogs: state.setLogs,
      setFilters: state.setFilters,
      clearFilters: state.clearFilters,
      setAutoScroll: state.setAutoScroll,
      toggleExpanded: state.toggleExpanded,
    }))
  );

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const sourcesRef = useRef<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const pauseBoundaryTsRef = useRef<number | undefined>(undefined);
  const [copyMeta, setCopyMeta] = useState<LogEntryCopyMeta>(() => ({
    appVersion: "unknown",
    electronVersion: extractElectronVersion(),
    platform: typeof navigator !== "undefined" ? navigator.platform : "unknown",
  }));

  useEffect(() => {
    let disposed = false;
    appClient
      .getVersion()
      .then((v) => {
        if (!disposed) setCopyMeta((m) => ({ ...m, appVersion: v }));
      })
      .catch(() => {
        /* keep fallback "unknown" */
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const bufferedLogs: LogEntryType[] = [];
    let hydrated = false;
    let disposed = false;

    const unsubscribe = logsClient.onBatch((entries: LogEntryType[]) => {
      if (disposed || !Array.isArray(entries) || entries.length === 0) return;

      if (!hydrated) {
        bufferedLogs.push(...entries);
        return;
      }

      addLogs(entries);
      const newSources = entries
        .map((entry) => entry.source)
        .filter((source): source is string => !!source && !sourcesRef.current.includes(source));
      if (newSources.length > 0) {
        sourcesRef.current = [...sourcesRef.current, ...newSources].sort();
        setSources(sourcesRef.current);
        onSourcesChange?.(sourcesRef.current);
      }
    });

    Promise.all([
      logsClient.getAll().catch((error) => {
        console.error("Failed to load logs:", error);
        return [];
      }),
      logsClient.getSources().catch((error) => {
        console.error("Failed to load log sources:", error);
        return [];
      }),
    ]).then(([existingLogs, existingSources]) => {
      if (disposed) return;

      const deduped = new Map<string, LogEntryType>();
      for (const log of existingLogs) deduped.set(log.id, log);
      for (const log of bufferedLogs) deduped.set(log.id, log);

      const allLogs = Array.from(deduped.values()).sort((a, b) => a.timestamp - b.timestamp);
      setLogs(allLogs);

      const allSources = new Set([...existingSources]);
      for (const log of bufferedLogs) {
        if (log.source) allSources.add(log.source);
      }
      sourcesRef.current = Array.from(allSources).sort();
      setSources(sourcesRef.current);
      onSourcesChange?.(sourcesRef.current);

      hydrated = true;
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [addLogs, setLogs, onSourcesChange]);

  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = { ...EMPTY_LEVEL_COUNTS };
    for (const log of logs) {
      if (log.id === "previous-session-separator") continue;
      counts[log.level]++;
    }
    return counts;
  }, [logs]);

  const filteredLogs = useMemo(() => filterLogs(logs, filters), [logs, filters]);

  const previousSessionEntry = filteredLogs.find((log) => log.id === "previous-session-separator");
  const mainLogs = useMemo(
    () => filteredLogs.filter((log) => log.id !== "previous-session-separator"),
    [filteredLogs]
  );

  const displayEntries = useMemo(() => collapseConsecutiveDuplicates(mainLogs), [mainLogs]);

  const handleAtBottomChange = useCallback(
    (bottom: boolean) => {
      setAtBottom(bottom);
      if (bottom) {
        setNewCount(0);
        pauseBoundaryTsRef.current = undefined;
      } else {
        pauseBoundaryTsRef.current = mainLogs[mainLogs.length - 1]?.timestamp;
        if (autoScroll) setAutoScroll(false);
      }
    },
    [autoScroll, setAutoScroll, mainLogs]
  );

  useEffect(() => {
    if (atBottom) return;
    const boundaryTs = pauseBoundaryTsRef.current;
    if (boundaryTs === undefined) {
      setNewCount(0);
      return;
    }
    let count = 0;
    for (const log of mainLogs) {
      if (log.timestamp > boundaryTs) count++;
    }
    setNewCount(count);
  }, [mainLogs, atBottom]);

  const scrollToBottom = useCallback(() => {
    setAutoScroll(true);
    setNewCount(0);
    pauseBoundaryTsRef.current = undefined;
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      behavior: "smooth",
    });
  }, [setAutoScroll]);

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <LogFilters
        filters={filters}
        onFiltersChange={setFilters}
        onClear={clearFilters}
        availableSources={sources}
        levelCounts={levelCounts}
      />

      {previousSessionEntry && !filters?.search && (
        <div className="shrink-0 max-h-48 overflow-y-auto overflow-x-hidden border-b border-daintree-border bg-surface-panel/50 p-3">
          <div className="flex items-center gap-2 text-text-secondary text-xs font-medium mb-2">
            <div className="w-2 h-2 rounded-full bg-text-secondary/40" />
            <span>Previous session</span>
          </div>
          <pre className="text-xs text-text-muted whitespace-pre-wrap break-all font-mono">
            {String(previousSessionEntry.context?.tail || "")}
          </pre>
        </div>
      )}

      <div className="flex-1 relative min-h-0">
        {displayEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-daintree-text/60 text-sm">
            {logs.length === 0 && !previousSessionEntry
              ? "No logs yet"
              : logs.length === 0
                ? "No new logs this session"
                : "No logs match filters"}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={displayEntries}
            followOutput={autoScroll ? "smooth" : false}
            atBottomStateChange={handleAtBottomChange}
            computeItemKey={(_index, display) => display.entry.id}
            itemContent={(_index, display) => (
              <LogEntry
                entry={display.entry}
                count={display.count}
                copyMeta={copyMeta}
                isExpanded={expandedIds.has(display.entry.id)}
                onToggle={() => toggleExpanded(display.entry.id)}
              />
            )}
            className="absolute inset-0 overflow-y-auto overflow-x-hidden font-mono"
          />
        )}

        {!atBottom && displayEntries.length > 0 && (
          <Button
            variant="info"
            size="sm"
            className="absolute bottom-4 right-4 rounded-full shadow-[var(--theme-shadow-floating)] tabular-nums"
            onClick={scrollToBottom}
            aria-label={newCount > 0 ? `Resume tail, ${newCount} new` : "Scroll to bottom"}
          >
            {newCount > 0 ? `↓ ${newCount} new` : "Scroll to bottom"}
          </Button>
        )}
      </div>
    </div>
  );
}
