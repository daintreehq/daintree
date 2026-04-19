import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useLogsStore, filterLogs } from "@/store";
import { LogEntry } from "../Logs/LogEntry";
import { LogFilters } from "../Logs/LogFilters";
import type { LogEntry as LogEntryType } from "@/types";

import { logsClient } from "@/clients";

export interface LogsContentProps {
  className?: string;
  onSourcesChange?: (sources: string[]) => void;
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
  // Mirror into state so JSX doesn't read the ref during render (React Compiler).
  const [sources, setSources] = useState<string[]>([]);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const bufferedLogs: LogEntryType[] = [];
    let hydrated = false;

    const unsubscribe = logsClient.onBatch((entries: LogEntryType[]) => {
      if (!Array.isArray(entries) || entries.length === 0) return;

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
      unsubscribe();
    };
  }, [addLogs, setLogs, onSourcesChange]);

  const handleAtBottomChange = useCallback(
    (bottom: boolean) => {
      setAtBottom(bottom);
      if (!bottom && autoScroll) {
        setAutoScroll(false);
      }
    },
    [autoScroll, setAutoScroll]
  );

  const scrollToBottom = useCallback(() => {
    setAutoScroll(true);
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      behavior: "smooth",
    });
  }, [setAutoScroll]);

  const filteredLogs = useMemo(() => filterLogs(logs, filters), [logs, filters]);

  const previousSessionEntry = filteredLogs.find((log) => log.id === "previous-session-separator");
  const mainLogs = filteredLogs.filter((log) => log.id !== "previous-session-separator");

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <LogFilters
        filters={filters}
        onFiltersChange={setFilters}
        onClear={clearFilters}
        availableSources={sources}
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
        {mainLogs.length === 0 ? (
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
            data={mainLogs}
            followOutput={autoScroll ? "smooth" : false}
            atBottomStateChange={handleAtBottomChange}
            itemContent={(_index, entry) => (
              <LogEntry
                key={entry.id}
                entry={entry}
                isExpanded={expandedIds.has(entry.id)}
                onToggle={() => toggleExpanded(entry.id)}
              />
            )}
            className="absolute inset-0 overflow-y-auto overflow-x-hidden font-mono"
          />
        )}

        {!atBottom && mainLogs.length > 0 && (
          <Button
            variant="info"
            size="sm"
            className="absolute bottom-4 right-4 rounded-full shadow-[var(--theme-shadow-floating)]"
            onClick={scrollToBottom}
          >
            Scroll to bottom
          </Button>
        )}
      </div>
    </div>
  );
}
