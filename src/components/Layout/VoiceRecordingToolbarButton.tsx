import { Mic } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useKeybindingDisplay } from "@/hooks";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function VoiceRecordingToolbarButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const activeTarget = useVoiceRecordingStore((state) => state.activeTarget);
  const status = useVoiceRecordingStore((state) => state.status);
  const elapsedSeconds = useVoiceRecordingStore((state) => state.elapsedSeconds);
  const audioLevel = useVoiceRecordingStore((state) => state.audioLevel);
  const shortcut = useKeybindingDisplay("voiceInput.toggle");

  if (
    !activeTarget ||
    (status !== "connecting" && status !== "recording" && status !== "finishing")
  ) {
    return null;
  }

  const isRecording = status === "recording";

  const contextLabel = [activeTarget.projectName, activeTarget.worktreeLabel]
    .filter(Boolean)
    .join(" / ");
  const tooltipTitle =
    status === "connecting"
      ? "Preparing dictation..."
      : status === "finishing"
        ? "Finishing transcription..."
        : contextLabel
          ? `Recording: ${contextLabel}`
          : "Recording in another panel";
  const tooltipExtra = [
    status === "recording" ? formatDuration(elapsedSeconds) : null,
    shortcut ? `Press ${shortcut} to stop` : "Click to jump to panel",
  ]
    .filter(Boolean)
    .join(" \u00B7 ");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            data-toolbar-item={dataToolbarItem}
            onClick={() => {
              void voiceRecordingService.focusActiveTarget();
            }}
            className={cn(
              "toolbar-icon-button relative transition-colors mr-0.5",
              isRecording
                ? "text-daintree-text hover:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))]"
                : status === "connecting"
                  ? "text-daintree-text/60 hover:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))]"
                  : "text-daintree-accent hover:text-daintree-accent"
            )}
            aria-label={tooltipTitle}
          >
            {status === "finishing" ? (
              <Spinner size="md" />
            ) : (
              <div className="relative">
                <Mic className="h-4 w-4" />
                <span
                  className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full transition-colors"
                  style={{
                    backgroundColor:
                      status === "connecting"
                        ? "rgba(var(--theme-accent-rgb), 0.4)"
                        : `rgba(var(--theme-accent-rgb), ${0.3 + audioLevel * 0.7})`,
                    transitionDuration: "80ms",
                  }}
                />
              </div>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-center">
          <div className="font-medium">{tooltipTitle}</div>
          {tooltipExtra && <div className="text-[11px] text-daintree-text/60">{tooltipExtra}</div>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
