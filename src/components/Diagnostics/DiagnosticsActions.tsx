import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLogsStore, useErrorStore } from "@/store";
import { useTelemetryPreviewStore } from "@/store/telemetryPreviewStore";
import { usePerfMetricsStore } from "@/store/perfMetricsStore";
import { useProjectStore } from "@/store/projectStore";
import { actionService } from "@/services/ActionService";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { logError } from "@/utils/logger";
import {
  CLEAR_LOGS_CONFIRM_LABEL,
  CLEAR_LOGS_DESCRIPTION,
  CLEAR_LOGS_TITLE,
  notifyClearLogsFailed,
} from "@/lib/clearLogsCopy";

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
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const handleOpenFile = useCallback(async () => {
    await actionService.dispatch("logs.openFile", undefined, { source: "user" });
  }, []);

  const handleConfirmClear = useCallback(async () => {
    setIsClearing(true);
    try {
      const result = await actionService.dispatch("logs.clear", undefined, { source: "user" });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      logError("Failed to clear logs", error);
      // "Try again" reopens the confirm rather than re-dispatching: a toast that
      // fires a destructive action directly would bypass the D1 gate.
      notifyClearLogsFailed(() => setShowClearDialog(true));
    } finally {
      setIsClearing(false);
      setShowClearDialog(false);
    }
  }, []);

  return (
    <>
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
            <Button variant="subtle" size="xs" onClick={() => setShowClearDialog(true)}>
              Clear
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Clear logs</TooltipContent>
        </Tooltip>
      </div>
      <ConfirmDialog
        isOpen={showClearDialog}
        onClose={() => setShowClearDialog(false)}
        title={CLEAR_LOGS_TITLE}
        description={CLEAR_LOGS_DESCRIPTION}
        confirmLabel={CLEAR_LOGS_CONFIRM_LABEL}
        variant="destructive"
        isConfirmLoading={isClearing}
        onConfirm={handleConfirmClear}
      />
    </>
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

export function PerfActions() {
  const isLoading = usePerfMetricsStore((s) => s.isLoadingSummaries);
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);

  const handleRefresh = useCallback(() => {
    if (!projectPath) return;
    void usePerfMetricsStore.getState().refreshSummaries(projectPath);
  }, [projectPath]);

  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              variant="subtle"
              size="xs"
              onClick={handleRefresh}
              disabled={isLoading || !projectPath}
            >
              Refresh
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Re-read perf result files</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function EventsActions() {
  const [showClearDialog, setShowClearDialog] = useState(false);

  const handleConfirmClear = useCallback(async () => {
    await actionService.dispatch("eventInspector.clear", undefined, { source: "user" });
    setShowClearDialog(false);
  }, []);

  return (
    <>
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="subtle" size="xs" onClick={() => setShowClearDialog(true)}>
              Clear
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Clear all events</TooltipContent>
        </Tooltip>
      </div>
      <ConfirmDialog
        isOpen={showClearDialog}
        onClose={() => setShowClearDialog(false)}
        title="Clear events?"
        description="All captured event records will be permanently deleted."
        confirmLabel="Clear events"
        variant="destructive"
        onConfirm={handleConfirmClear}
      />
    </>
  );
}
