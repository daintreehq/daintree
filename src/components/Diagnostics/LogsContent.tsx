import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ArrowDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DiagnosticsNotice } from "./DiagnosticsNotice";
import { ListSkeleton } from "./ListSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  useLogsStore,
  filterLogs,
  collapseConsecutiveDuplicates,
  type DisplayEntry,
} from "@/store";
import { LogEntry, type LogEntryCopyMeta } from "../Logs/LogEntry";
import { LogFilters } from "../Logs/LogFilters";
import type { LogEntry as LogEntryType, LogLevel } from "@/types";

import { logsClient, appClient } from "@/clients";
import { logError } from "@/utils/logger";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";

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

interface LogEntryRowProps {
  display: DisplayEntry;
  copyMeta: LogEntryCopyMeta;
  isExpanded: boolean;
  toggleExpanded: (id: string) => void;
}

function LogEntryRow({ display, copyMeta, isExpanded, toggleExpanded }: LogEntryRowProps) {
  const onToggle = useCallback(
    () => toggleExpanded(display.entry.id),
    [toggleExpanded, display.entry.id]
  );
  return (
    <LogEntry
      entry={display.entry}
      count={display.count}
      copyMeta={copyMeta}
      isExpanded={isExpanded}
      onToggle={onToggle}
    />
  );
}

export function LogsContent({ className, onSourcesChange }: LogsContentProps) {
  const {
    logs,
    filters,
    filtersResetCount,
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
      filtersResetCount: state.filtersResetCount,
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
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [showPreviousSession, setShowPreviousSession] = useState(false);
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

    let readFailed = false;
    setLoadState("loading");
    Promise.all([
      logsClient.getAll().catch((error) => {
        logError("Failed to load logs", error);
        readFailed = true;
        return [];
      }),
      logsClient.getSources().catch((error) => {
        logError("Failed to load log sources", error);
        return [];
      }),
    ]).then(([existingLogs, existingSources]) => {
      if (disposed) return;

      // A failed read has no history to replace what's already on screen with:
      // entries that arrived live since the dock opened stay, and only a
      // successful read is authoritative enough to replace them.
      const base = readFailed ? useLogsStore.getState().logs : existingLogs;
      const deduped = new Map<string, LogEntryType>();
      for (const log of base) deduped.set(log.id, log);
      for (const log of bufferedLogs) deduped.set(log.id, log);

      const allLogs = Array.from(deduped.values()).sort((a, b) => a.timestamp - b.timestamp);
      setLogs(allLogs);

      const allSources = new Set([...existingSources, ...(readFailed ? sourcesRef.current : [])]);
      for (const log of bufferedLogs) {
        if (log.source) allSources.add(log.source);
      }
      sourcesRef.current = Array.from(allSources).sort();
      setSources(sourcesRef.current);
      onSourcesChange?.(sourcesRef.current);

      hydrated = true;
      setLoadState(readFailed ? "failed" : "loaded");
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [addLogs, setLogs, onSourcesChange, reloadKey]);

  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = { ...EMPTY_LEVEL_COUNTS };
    for (const log of logs) {
      if (log.id === "previous-session-separator") continue;
      counts[log.level]++;
    }
    return counts;
  }, [logs]);

  const sourceCounts = useMemo(() => {
    const counts: Partial<Record<string, number>> = {};
    for (const log of logs) {
      if (log.id === "previous-session-separator") continue;
      if (!log.source) continue;
      counts[log.source] = (counts[log.source] ?? 0) + 1;
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
  const deferredDisplayEntries = useDeferredValue(displayEntries);

  const hasActiveFilters =
    (filters.levels?.length ?? 0) > 0 ||
    (filters.sources?.length ?? 0) > 0 ||
    !!filters.search ||
    filters.startTime !== undefined ||
    filters.endTime !== undefined;

  // Virtuoso reports "not at bottom" while it lays out its first frame, before
  // the initial scroll to the tail lands. Treating that as the user scrolling
  // away turned auto-scroll off on every open, so only a departure after the
  // list has reached the bottom once counts.
  const reachedBottomRef = useRef(false);
  // The list unmounts whenever nothing matches, and a remounted list lays out
  // afresh — so the guard is per mount of the list, not per mount of the tab.
  const listMounted = displayEntries.length > 0;
  useEffect(() => {
    if (!listMounted) reachedBottomRef.current = false;
  }, [listMounted]);
  const handleAtBottomChange = useCallback(
    (bottom: boolean) => {
      if (bottom) reachedBottomRef.current = true;
      else if (!reachedBottomRef.current) return;
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
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [setAutoScroll]);

  const previousSessionTail = previousSessionEntry
    ? String(previousSessionEntry.context?.tail || "")
    : "";
  const previousSessionLines = previousSessionTail ? previousSessionTail.split("\n").length : 0;
  const hasLiveLogs = logs.some((l) => l.id !== "previous-session-separator");

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <LogFilters
        filters={filters}
        onFiltersChange={setFilters}
        onClear={clearFilters}
        availableSources={sources}
        levelCounts={levelCounts}
        sourceCounts={sourceCounts}
        resetSignal={filtersResetCount}
      />

      {previousSessionEntry && previousSessionTail && !filters?.search && (
        <div className="shrink-0 border-b border-divider">
          <button
            type="button"
            onClick={() => setShowPreviousSession((v) => !v)}
            aria-expanded={showPreviousSession}
            aria-controls="logs-previous-session"
            className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs text-text-secondary hover:bg-overlay-subtle hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-transform duration-150 ease-out",
                showPreviousSession && "rotate-90"
              )}
            />
            <span className="font-medium">Previous session</span>
            <span>· last {previousSessionLines} lines before Daintree restarted</span>
          </button>
          {showPreviousSession ? (
            <pre
              id="logs-previous-session"
              className="max-h-32 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all px-3 pb-2 pl-8 font-mono text-xs text-text-secondary select-text"
            >
              {previousSessionTail}
            </pre>
          ) : null}
        </div>
      )}

      {loadState === "failed" && hasLiveLogs ? (
        <DiagnosticsNotice
          kind="failed"
          className="mx-3 mt-2"
          title="Couldn't read earlier log entries"
          description="Only entries since the dock opened are shown. Open the log file to see everything."
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : null}

      <div className="flex-1 relative min-h-0">
        {loadState === "failed" && !hasLiveLogs ? (
          <div className="p-3">
            <DiagnosticsNotice
              kind="failed"
              title="Couldn't read the app log"
              description="New entries still appear here as they're written. Open the log file to see everything."
              onRetry={() => setReloadKey((k) => k + 1)}
            />
          </div>
        ) : displayEntries.length === 0 ? (
          loadState === "loading" ? (
            <ListSkeleton label="Loading logs" />
          ) : hasLiveLogs && hasActiveFilters ? (
            <div className="flex items-center justify-center h-full">
              <EmptyState
                variant="filtered-empty"
                scale="sidebar"
                title="No logs match filters"
                action={
                  <Button variant="subtle" size="xs" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              {logs.length === 0 && !previousSessionEntry ? (
                <EmptyState
                  key="zero-data"
                  variant="zero-data"
                  scale="sidebar"
                  title="No logs yet"
                />
              ) : (
                <EmptyState
                  key="user-cleared"
                  variant="user-cleared"
                  scale="sidebar"
                  title="No new logs this session"
                />
              )}
            </div>
          )
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={deferredDisplayEntries}
            // Someone opening the log is looking for what just happened, so it
            // opens at the newest line rather than the oldest.
            initialTopMostItemIndex={{ index: "LAST", align: "end" }}
            followOutput={
              autoScroll
                ? (isAtBottom) =>
                    isAtBottom ? (prefersReducedMotion() ? "auto" : "smooth") : false
                : false
            }
            atBottomStateChange={handleAtBottomChange}
            computeItemKey={(_index, display) => display.entry.id}
            itemContent={(_index, display) => (
              <LogEntryRow
                display={display}
                copyMeta={copyMeta}
                isExpanded={expandedIds.has(display.entry.id)}
                toggleExpanded={toggleExpanded}
              />
            )}
            role="log"
            aria-label="Application logs"
            aria-live="off"
            className="absolute inset-0 overflow-y-auto overflow-x-hidden font-mono"
          />
        )}

        {!atBottom && displayEntries.length > 0 && (
          <Button
            variant="pill"
            size="sm"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-[var(--theme-shadow-floating)] tabular-nums"
            onClick={scrollToBottom}
            aria-label={newCount > 0 ? `${newCount} new, resume tail` : undefined}
          >
            <ArrowDown />
            {newCount > 0 ? `${newCount} new` : "Jump to latest"}
          </Button>
        )}
      </div>
    </div>
  );
}
