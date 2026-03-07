import { useCallback } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";

interface VoiceInputButtonProps {
  panelId: string;
  panelTitle?: string;
  projectId?: string;
  projectName?: string;
  worktreeId?: string;
  worktreeLabel?: string;
  disabled?: boolean;
}

export function VoiceInputButton({
  panelId,
  panelTitle,
  projectId,
  projectName,
  worktreeId,
  worktreeLabel,
  disabled = false,
}: VoiceInputButtonProps) {
  const status = useVoiceRecordingStore((state) => state.status);
  const isConfigured = useVoiceRecordingStore((state) => state.isConfigured);
  const errorMessage = useVoiceRecordingStore((state) => state.errorMessage);
  const activePanelId = useVoiceRecordingStore((state) => state.activeTarget?.panelId ?? null);

  const isRecording = activePanelId === panelId && status === "recording";
  const isConnecting = activePanelId === panelId && status === "connecting";

  const handleClick = useCallback(async () => {
    if (disabled && !isRecording && !isConnecting) return;

    if (!isConfigured && !isRecording && !isConnecting) {
      const fresh = await window.electron?.voiceInput?.getSettings();
      if (fresh?.enabled && fresh.apiKey) {
        void voiceRecordingService.toggle({
          panelId,
          panelTitle,
          projectId,
          projectName,
          worktreeId,
          worktreeLabel,
        });
        return;
      }

      void actionService.dispatch("app.settings.openTab", { tab: "voice" }, { source: "user" });
      return;
    }

    void voiceRecordingService.toggle({
      panelId,
      panelTitle,
      projectId,
      projectName,
      worktreeId,
      worktreeLabel,
    });
  }, [
    disabled,
    isConfigured,
    isConnecting,
    isRecording,
    panelId,
    panelTitle,
    projectId,
    projectName,
    worktreeId,
    worktreeLabel,
  ]);

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled && !isRecording && !isConnecting}
        title={
          !isConfigured
            ? "Configure voice input"
            : status === "error"
              ? (errorMessage ?? "Voice input error")
              : isRecording
                ? "Stop recording"
                : "Start voice input"
        }
        className={cn(
          "relative flex items-center justify-center rounded-full transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1",
          isRecording
            ? "h-6 w-6 bg-canopy-accent/20 text-canopy-accent hover:bg-canopy-accent/30"
            : isConnecting
              ? "h-6 w-6 p-1 text-canopy-text/40"
              : cn(
                  "p-1",
                  status === "error"
                    ? "text-yellow-400 hover:text-yellow-300"
                    : "text-canopy-text/40 hover:text-canopy-text/70"
                ),
          disabled && !isRecording && "pointer-events-none opacity-40"
        )}
        aria-label={
          !isConfigured
            ? "Set up voice input"
            : isRecording
              ? "Stop voice recording"
              : "Start voice recording"
        }
        aria-pressed={isConfigured ? isRecording : undefined}
      >
        {isRecording && (
          <span
            className="absolute inset-0 animate-spin rounded-full"
            style={{
              background: `conic-gradient(rgba(var(--theme-accent-rgb), 0.7), rgba(var(--theme-accent-rgb), 0.15), rgba(var(--theme-accent-rgb), 0.7))`,
              mask: "radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px))",
              WebkitMask:
                "radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px))",
              animationDuration: "1.5s",
            }}
          />
        )}
        {isConnecting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : isConfigured ? (
          <Mic className="h-3 w-3 relative" />
        ) : (
          <MicOff className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
