import { useCallback } from "react";
import { Mic, MicOff, Square, Loader2 } from "lucide-react";
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
  const audioLevel = useVoiceRecordingStore((state) => state.audioLevel);

  const isRecording = activePanelId === panelId && status === "recording";
  const isConnecting = activePanelId === panelId && status === "connecting";
  const isFinishing = activePanelId === panelId && status === "finishing";
  const isActive = isRecording || isConnecting || isFinishing;

  const handleClick = useCallback(async () => {
    if (disabled && !isActive) return;

    if (!isConfigured && !isActive) {
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
    isActive,
    isConfigured,
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
        disabled={(disabled && !isActive) || isFinishing}
        title={
          !isConfigured
            ? "Configure voice input"
            : status === "error"
              ? (errorMessage ?? "Voice input error")
              : isFinishing
                ? "Finishing transcription..."
                : isRecording
                  ? "Stop recording"
                  : "Start voice input"
        }
        className={cn(
          "relative flex items-center justify-center rounded-[var(--radius-sm)] transition-colors",
          "h-6 w-6",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent",
          isRecording
            ? "bg-green-500/15 text-green-400 border border-green-500/40 hover:bg-green-500/25"
            : isConnecting
              ? "text-canopy-text/40"
              : isFinishing
                ? "text-yellow-400"
                : cn(
                    status === "error"
                      ? "text-yellow-400 hover:text-yellow-300"
                      : "text-canopy-text/50 hover:text-canopy-text/80 hover:bg-white/[0.06]"
                  ),
          disabled && !isActive && "pointer-events-none opacity-40"
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
            className="absolute inset-[-3px] rounded-[var(--radius-sm)] pointer-events-none transition-shadow"
            style={{
              boxShadow: `0 0 ${4 + audioLevel * 10}px ${1 + audioLevel * 3}px rgba(74, 222, 128, ${0.1 + audioLevel * 0.4})`,
              transitionDuration: "80ms",
            }}
          />
        )}
        {isConnecting || isFinishing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : isRecording ? (
          <Square className="h-2.5 w-2.5 fill-current relative" />
        ) : isConfigured ? (
          <Mic className="h-3.5 w-3.5 relative" />
        ) : (
          <MicOff className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
