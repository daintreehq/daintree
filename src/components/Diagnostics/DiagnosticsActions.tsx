import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLogsStore, useErrorStore } from "@/store";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useTelemetryPreviewStore } from "@/store/telemetryPreviewStore";
import { actionService } from "@/services/ActionService";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Callout } from "@/components/ui/Callout";
import { logError } from "@/utils/logger";
import { ClearLogsConfirmDialog } from "./ClearLogsConfirmDialog";

// The button that fires these goes disabled once nothing is left to clear, and
// a disabled control can't hold focus, so the keyboard returns to the tab bar.
async function clearAndKeepFocus(
  actionId: "errors.clearAll" | "telemetry.clearPreview",
  focusVisible: boolean
) {
  const result = await actionService.dispatch(actionId, undefined, { source: "user" });
  if (result.ok) useDiagnosticsStore.getState().requestTabFocus(focusVisible);
}

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
              onClick={(e) => void clearAndKeepFocus("errors.clearAll", e.detail === 0)}
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
              pressed={autoScroll}
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

  const handleClear = useCallback((e: React.MouseEvent) => {
    void clearAndKeepFocus("telemetry.clearPreview", e.detail === 0);
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
              pressed={stateKnown ? active : undefined}
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
  const [isClearing, setIsClearing] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);

  // A failure keeps the confirmation open, its button ready to retry. A toast
  // retry would close over this component, which unmounts with any tab switch.
  // No `finally`: React Compiler bails out on a try with a finalizer.
  const handleConfirmClear = useCallback(async () => {
    setIsClearing(true);
    setClearFailed(false);
    let failure: unknown = null;
    try {
      const result = await actionService.dispatch("eventInspector.clear", undefined, {
        source: "user",
      });
      if (!result.ok) failure = new Error(result.error.message);
    } catch (error) {
      failure = error;
    }
    setIsClearing(false);
    if (failure === null) {
      setShowClearDialog(false);
      return;
    }
    logError("Failed to clear events", failure);
    setClearFailed(true);
  }, []);

  const closeClearDialog = useCallback(() => {
    setShowClearDialog(false);
    setClearFailed(false);
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
        onClose={closeClearDialog}
        title="Clear events?"
        description="All captured event records will be permanently deleted."
        confirmLabel="Clear events"
        variant="destructive"
        isConfirmLoading={isClearing}
        onConfirm={handleConfirmClear}
      >
        {clearFailed && (
          // Claims only the failed attempt: a reply lost on the way back can
          // follow a clear that did happen in main.
          <Callout severity="error" role="alert" title="Couldn't clear events">
            The app didn't confirm the clear. Try again in a moment.
          </Callout>
        )}
      </ConfirmDialog>
    </>
  );
}
