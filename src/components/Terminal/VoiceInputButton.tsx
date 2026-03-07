import { useCallback, useEffect, useRef } from "react";
import { Mic, MicOff, Square, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";

// Flywheel — exponential smoothing with tau=0.85s (~2.5s to 95% convergence)
const IDLE_SPEED = 120; // deg/sec — 1 revolution per 3s
const ACTIVE_SPEED = 300; // deg/sec — 1 revolution per 1.2s
const TAU = 0.85; // smoothing time constant in seconds

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
  const isListening = isRecording || isConnecting;
  const isActive = isListening || isFinishing;

  // Animation refs
  const wrapperRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number>(0);
  const audioLevelRef = useRef(0);

  useEffect(() => {
    audioLevelRef.current = audioLevel;
  }, [audioLevel]);

  useEffect(() => {
    if (!isListening) return;

    let lastTime = performance.now();
    let angle = 0;
    let velocity = IDLE_SPEED;

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1); // seconds, capped
      lastTime = now;

      const level = audioLevelRef.current;

      // Target velocity: idle when quiet, active when speaking
      const targetVelocity = IDLE_SPEED + level * (ACTIVE_SPEED - IDLE_SPEED);

      // Exponential smoothing — smooth ramp up and down
      velocity += (targetVelocity - velocity) * (1 - Math.exp(-dt / TAU));

      angle = (angle + velocity * dt) % 360;

      // Arc brightness from real-time audio level
      const opacity = (0.3 + level * 0.6).toFixed(3);
      // Arc thickness from audio level
      const thickness = (1.5 + level * 1).toFixed(2);

      // Rotate the whole wrapper — dot is locked inside at the gradient's bright edge
      const wrapper = wrapperRef.current;
      if (wrapper) {
        wrapper.style.transform = `rotate(${angle}deg) translateZ(0)`;
      }

      // Update ring gradient opacity and thickness
      const ring = ringRef.current;
      if (ring) {
        ring.style.padding = `${thickness}px`;
        ring.style.background = `conic-gradient(from 0deg, transparent 240deg, rgba(var(--theme-accent-rgb), ${opacity}) 360deg)`;
      }

      // Update dot opacity
      const dot = dotRef.current;
      if (dot) {
        dot.style.opacity = String(0.5 + level * 0.5);
        const glowSize = 3 + level * 4;
        const glowSpread = 1 + level * 2;
        dot.style.boxShadow = `0 0 ${glowSize}px ${glowSpread}px rgba(var(--theme-accent-rgb), ${opacity})`;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isListening]);

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
      {isListening && (
        <>
          {/* Faint static track */}
          <span className="absolute inset-0 rounded-full pointer-events-none border border-canopy-accent/[0.08]" />
          {/* Rotating wrapper — contains both the arc and the dot, locked together */}
          <div
            ref={wrapperRef}
            className="absolute inset-0 pointer-events-none"
            style={{ willChange: "transform" }}
          >
            {/* Arc ring — conic gradient masked to a thin stroke */}
            <span
              ref={ringRef}
              className="absolute inset-0 rounded-full"
              style={{
                padding: "1.5px",
                mask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
                WebkitMask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
                maskComposite: "exclude",
                WebkitMaskComposite: "xor",
              }}
            />
            {/* Dot — positioned at top-center, exactly where the gradient peaks (360deg) */}
            <span
              ref={dotRef}
              className="absolute rounded-full bg-canopy-accent"
              style={{
                width: "4px",
                height: "4px",
                top: "-0.5px",
                left: "calc(50% - 2px)",
                filter: "blur(0.5px)",
              }}
            />
          </div>
        </>
      )}
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
                : isListening
                  ? "Stop recording"
                  : "Start voice input"
        }
        className={cn(
          "relative flex items-center justify-center rounded-full transition-all",
          "h-6 w-6",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent",
          isListening
            ? "bg-canopy-accent/10 text-canopy-accent hover:bg-canopy-accent/15"
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
            : isListening
              ? "Stop voice recording"
              : "Start voice recording"
        }
        aria-pressed={isConfigured ? isListening : undefined}
      >
        {isFinishing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : isListening ? (
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
