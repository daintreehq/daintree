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

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <LogFilters
        filters={filters}
        onFiltersChange={setFilters}
        onClear={clearFilters}
        availableSources={sourcesRef.current}
      />

      <div className="flex-1 relative">
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-daintree-text/60 text-sm">
            {logs.length === 0 ? "No logs yet" : "No logs match filters"}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={filteredLogs}
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

        {!atBottom && filteredLogs.length > 0 && (
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
