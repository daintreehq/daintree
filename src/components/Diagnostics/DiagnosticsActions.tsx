import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useLogsStore, useErrorStore } from "@/store";
import { useEventStore } from "@/store/eventStore";
import { logsClient, eventInspectorClient, errorsClient } from "@/clients";

export function ProblemsActions() {
  const hasActiveErrors = useErrorStore((state) => state.errors.some((e) => !e.dismissed));
  const clearAll = useErrorStore((state) => state.clearAll);

  const handleOpenLogs = useCallback(() => {
    errorsClient.openLogs();
  }, []);

  return (
    <div className="flex items-center gap-2">
      <Button variant="subtle" size="xs" onClick={handleOpenLogs} title="Open log file">
        Open Logs
      </Button>
      <Button
        variant="subtle"
        size="xs"
        onClick={clearAll}
        disabled={!hasActiveErrors}
        title="Clear all errors"
      >
        Clear All
      </Button>
    </div>
  );
}

export function LogsActions() {
  const autoScroll = useLogsStore((state) => state.autoScroll);
  const setAutoScroll = useLogsStore((state) => state.setAutoScroll);
  const clearLogs = useLogsStore((state) => state.clearLogs);

  const handleOpenFile = useCallback(async () => {
    await logsClient.openFile();
  }, []);

  const handleClearLogs = useCallback(async () => {
    clearLogs();
    await logsClient.clear();
  }, [clearLogs]);

  return (
    <div className="flex items-center gap-2">
      <Button
        variant={autoScroll ? "info" : "subtle"}
        size="xs"
        onClick={() => setAutoScroll(!autoScroll)}
        title={autoScroll ? "Auto-scroll enabled" : "Auto-scroll disabled"}
      >
        Auto-scroll
      </Button>
      <Button variant="subtle" size="xs" onClick={handleOpenFile} title="Open log file">
        Open File
      </Button>
      <Button variant="subtle" size="xs" onClick={handleClearLogs} title="Clear logs">
        Clear
      </Button>
    </div>
  );
}

export function EventsActions() {
  const clearEvents = useEventStore((state) => state.clearEvents);

  const handleClearEvents = async () => {
    if (window.confirm("Clear all events? This cannot be undone.")) {
      // Clear local state
      clearEvents();
      // Clear main process buffer
      await eventInspectorClient.clear();
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button variant="subtle" size="xs" onClick={handleClearEvents} title="Clear all events">
        Clear
      </Button>
    </div>
  );
}
