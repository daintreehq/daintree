import { useCallback, useEffect, useRef } from "react";
import { Mic, MicOff, Square, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";

// Flywheel — double-smoothed for S-curve easing (ease-in-out)
const IDLE_SPEED = 72; // deg/sec — 1 revolution per 5s (calm breathing pace)
const ACTIVE_SPEED = 288; // deg/sec — 1 revolution per 1.25s
const TAU_ATTACK = 0.25; // stacked with double-smooth → ~0.5s effective ease-in
const TAU_RELEASE = 0.6; // stacked → ~1.2s effective ease-out
const AUDIO_SMOOTH = 0.15; // low-pass filter on raw audio level

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
    let v1 = IDLE_SPEED; // intermediate velocity (first smooth)
    let velocity = IDLE_SPEED; // drawn velocity (second smooth — creates S-curve)
    let smoothLevel = 0;

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1); // seconds, capped
      lastTime = now;

      // Low-pass filter on raw audio — prevents micro-jitter
      smoothLevel += (audioLevelRef.current - smoothLevel) * AUDIO_SMOOTH;

      // Perceptual curve — background noise suppressed, speech pops
      const level = Math.pow(smoothLevel, 1.5);

      // Double-smoothed flywheel — cascaded for S-curve (ease-in-ease-out)
      const targetVelocity = IDLE_SPEED + level * (ACTIVE_SPEED - IDLE_SPEED);
      const tau = targetVelocity > velocity ? TAU_ATTACK : TAU_RELEASE;
      const alpha = 1 - Math.exp(-dt / tau);
      v1 += (targetVelocity - v1) * alpha;
      velocity += (v1 - velocity) * alpha;

      angle = (angle + velocity * dt) % 360;

      // Arc visuals from smoothed audio level
      const opacity = (0.45 + level * 0.55).toFixed(3);
      const thickness = (2 + level * 1).toFixed(2);

      // Rotate wrapper
      const wrapper = wrapperRef.current;
      if (wrapper) {
        wrapper.style.transform = `rotate(${angle}deg) translateZ(0)`;
      }

      // Update ring — longer 180° tail with exponential brightness ramp
      const ring = ringRef.current;
      if (ring) {
        ring.style.padding = `${thickness}px`;
        ring.style.background = [
          `conic-gradient(from 0deg,`,
          `transparent 180deg,`,
          `rgba(var(--theme-accent-rgb), ${Number(opacity) * 0.08}) 270deg,`,
          `rgba(var(--theme-accent-rgb), ${Number(opacity) * 0.4}) 330deg,`,
          `rgba(var(--theme-accent-rgb), ${opacity}) 360deg)`,
        ].join(" ");
      }

      // Update dot — soft glowing light source, no hard edges
      const dot = dotRef.current;
      if (dot) {
        dot.style.opacity = String(0.7 + level * 0.3);
        const glowSize = 5 + level * 7;
        dot.style.boxShadow = `0 0 ${glowSize}px rgba(var(--theme-accent-rgb), ${(0.5 + level * 0.5).toFixed(3)})`;
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
                width: "4.5px",
                height: "4.5px",
                top: "-0.75px",
                left: "calc(50% - 2.25px)",
                filter: "blur(1px)",
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
