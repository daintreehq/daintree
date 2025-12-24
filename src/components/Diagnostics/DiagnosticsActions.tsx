import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useLogsStore, useErrorStore } from "@/store";
import { actionService } from "@/services/ActionService";

export function ProblemsActions() {
  const hasActiveErrors = useErrorStore((state) => state.errors.some((e) => !e.dismissed));

  const handleOpenLogs = useCallback(() => {
    void actionService.dispatch("logs.openFile", undefined, { source: "user" });
  }, []);

  return (
    <div className="flex items-center gap-2">
      <Button variant="subtle" size="xs" onClick={handleOpenLogs} title="Open log file">
        Open Logs
      </Button>
      <Button
        variant="subtle"
        size="xs"
        onClick={() =>
          void actionService.dispatch("errors.clearAll", undefined, { source: "user" })
        }
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

  const handleOpenFile = useCallback(async () => {
    await actionService.dispatch("logs.openFile", undefined, { source: "user" });
  }, []);

  const handleClearLogs = useCallback(async () => {
    await actionService.dispatch("logs.clear", undefined, { source: "user" });
  }, []);

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
  const handleClearEvents = async () => {
    if (window.confirm("Clear all events? This cannot be undone.")) {
      await actionService.dispatch("eventInspector.clear", undefined, { source: "user" });
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
