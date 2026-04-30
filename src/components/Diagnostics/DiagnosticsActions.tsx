import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useLogsStore, useErrorStore } from "@/store";
import { useTelemetryPreviewStore } from "@/store/telemetryPreviewStore";
import { actionService } from "@/services/ActionService";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ProblemsActions() {
  const hasActiveErrors = useErrorStore((state) => state.errors.some((e) => !e.dismissed));

  const handleOpenLogs = useCallback(() => {
    void actionService.dispatch("logs.openFile", undefined, { source: "user" });
  }, []);

  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="subtle" size="xs" onClick={handleOpenLogs}>
            Open Logs
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open log file</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              variant="subtle"
              size="xs"
              onClick={() =>
                void actionService.dispatch("errors.clearAll", undefined, { source: "user" })
              }
              disabled={!hasActiveErrors}
            >
              Clear All
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Clear all errors</TooltipContent>
      </Tooltip>
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={autoScroll ? "info" : "subtle"}
            size="xs"
            onClick={() => setAutoScroll(!autoScroll)}
          >
            Auto-scroll
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {autoScroll ? "Auto-scroll enabled" : "Auto-scroll disabled"}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="subtle" size="xs" onClick={handleOpenFile}>
            Open File
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open log file</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="subtle" size="xs" onClick={handleClearLogs}>
            Clear
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Clear logs</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function TelemetryActions() {
  const active = useTelemetryPreviewStore((state) => state.active);
  const hasEvents = useTelemetryPreviewStore((state) => state.events.length > 0);

  const handleToggle = useCallback(() => {
    void actionService.dispatch("telemetry.togglePreview", undefined, { source: "user" });
  }, []);

  const handleClear = useCallback(() => {
    void actionService.dispatch("telemetry.clearPreview", undefined, { source: "user" });
  }, []);

  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={active ? "info" : "subtle"}
            size="xs"
            onClick={handleToggle}
            aria-pressed={active}
          >
            {active ? "Preview On" : "Preview Off"}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {active
            ? "Stop mirroring outbound telemetry payloads"
            : "Start mirroring outbound telemetry payloads"}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button variant="subtle" size="xs" onClick={handleClear} disabled={!hasEvents}>
              Clear
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Clear captured events</TooltipContent>
      </Tooltip>
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="subtle" size="xs" onClick={handleClearEvents}>
            Clear
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Clear all events</TooltipContent>
      </Tooltip>
    </div>
  );
}
