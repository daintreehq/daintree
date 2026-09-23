import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLogsStore, useErrorStore } from "@/store";
import { useTelemetryPreviewStore } from "@/store/telemetryPreviewStore";
import { actionService } from "@/services/ActionService";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ClearLogsConfirmDialog } from "./ClearLogsConfirmDialog";
import { PRESSED_TOGGLE } from "./toggleStyles";

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
            Open log file
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open the full app log in your editor</TooltipContent>
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
              Dismiss all
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Dismiss every problem in the list</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function LogsActions() {
  const autoScroll = useLogsStore((state) => state.autoScroll);
  const setAutoScroll = useLogsStore((state) => state.setAutoScroll);
  const [showClearDialog, setShowClearDialog] = useState(false);

  const handleOpenFile = useCallback(async () => {
    await actionService.dispatch("logs.openFile", undefined, { source: "user" });
  }, []);

  return (
    <>
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="subtle"
              size="xs"
              onClick={() => setAutoScroll(!autoScroll)}
              aria-pressed={autoScroll}
              className={cn(autoScroll && PRESSED_TOGGLE)}
            >
              Auto-scroll
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Keep the newest line in view</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="subtle" size="xs" onClick={handleOpenFile}>
              Open log file
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open the full app log in your editor</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="subtle" size="xs" onClick={() => setShowClearDialog(true)}>
              Clear logs
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Remove every entry from this view</TooltipContent>
        </Tooltip>
      </div>
      <ClearLogsConfirmDialog isOpen={showClearDialog} onOpenChange={setShowClearDialog} />
    </>
  );
}

export function TelemetryActions() {
  const active = useTelemetryPreviewStore((state) => state.active);
  // Flipping a setting whose current value is unknown would be a guess.
  const stateKnown = useTelemetryPreviewStore((state) => state.stateRead === "known");
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
          <span className="inline-flex">
            <Button
              variant="subtle"
              size="xs"
              onClick={handleToggle}
              disabled={!stateKnown}
              aria-pressed={stateKnown ? active : undefined}
              className={cn(stateKnown && active && PRESSED_TOGGLE)}
            >
              Telemetry preview
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {!stateKnown
            ? "Checking whether preview is on"
            : active
              ? "Stop mirroring outbound telemetry payloads"
              : "Start mirroring outbound telemetry payloads"}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button variant="subtle" size="xs" onClick={handleClear} disabled={!hasEvents}>
              Clear payloads
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Remove the captured payloads from this view</TooltipContent>
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
              Clear events
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Delete every captured event</TooltipContent>
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
