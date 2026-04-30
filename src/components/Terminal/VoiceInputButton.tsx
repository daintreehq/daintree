import { useCallback, useEffect, useRef } from "react";
import { Mic } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";

// Flywheel — double-smoothed for S-curve easing
const IDLE_SPEED = 72; // deg/sec — 1 revolution per 5s
const ACTIVE_SPEED = 288; // deg/sec — 1 revolution per 1.25s
const TAU_ATTACK = 0.22;
const TAU_RELEASE = 0.5;
const AUDIO_SMOOTH = 0.15;

// Ring thickness via scale (avoids layout thrashing)
const BASE_THICKNESS = 2; // px — fixed padding, animated via scale
const SCALE_MIN = 0.88;
const SCALE_MAX = 1.0;

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
  // Keep orbit visible through finishing for graceful exit
  const showOrbit = isListening || isFinishing;
  const isActive = isListening || isFinishing;

  // Animation refs
  const wrapperRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const dotCoreRef = useRef<HTMLSpanElement>(null);
  const dotHaloRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number>(0);
  const audioLevelRef = useRef(0);

  useEffect(() => {
    audioLevelRef.current = audioLevel;
  }, [audioLevel]);

  useEffect(() => {
    if (!showOrbit) return;

    let lastTime = performance.now();
    let angle = 0;
    let v1 = IDLE_SPEED;
    let velocity = IDLE_SPEED;
    let smoothLevel = 0;

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      // During finishing, force level to 0 so it winds down gracefully
      const rawLevel = isFinishing ? 0 : audioLevelRef.current;

      // Low-pass + perceptual curve
      smoothLevel += (rawLevel - smoothLevel) * AUDIO_SMOOTH;
      const level = Math.pow(smoothLevel, 1.5);

      // Double-smoothed flywheel
      const targetVelocity = IDLE_SPEED + level * (ACTIVE_SPEED - IDLE_SPEED);
      const tau = targetVelocity > velocity ? TAU_ATTACK : TAU_RELEASE;
      const alpha = 1 - Math.exp(-dt / tau);
      v1 += (targetVelocity - v1) * alpha;
      velocity += (v1 - velocity) * alpha;

      angle = (angle + velocity * dt) % 360;

      // Energy ratio for visual mapping
      const opacity = (0.45 + level * 0.55).toFixed(3);
      const opacityNum = Number(opacity);
      const scale = SCALE_MIN + level * (SCALE_MAX - SCALE_MIN);

      // Rotate wrapper with scale for thickness modulation
      const wrapper = wrapperRef.current;
      if (wrapper) {
        wrapper.style.transform = `rotate(${angle}deg) scale(${scale}) translateZ(0)`;
      }

      // Refined gradient — exponential clustering near the head
      const ring = ringRef.current;
      if (ring) {
        ring.style.background = [
          `conic-gradient(from 0deg,`,
          `transparent 200deg,`,
          `rgba(var(--theme-accent-rgb), ${(opacityNum * 0.05).toFixed(3)}) 248deg,`,
          `rgba(var(--theme-accent-rgb), ${(opacityNum * 0.18).toFixed(3)}) 292deg,`,
          `rgba(var(--theme-accent-rgb), ${(opacityNum * 0.42).toFixed(3)}) 326deg,`,
          `rgba(var(--theme-accent-rgb), ${(opacityNum * 0.82).toFixed(3)}) 348deg,`,
          `rgba(var(--theme-accent-rgb), ${opacity}) 355deg,`,
          `transparent 360deg)`,
        ].join(" ");
      }

      // Dot core — crisp, no blur
      const core = dotCoreRef.current;
      if (core) {
        core.style.opacity = String(0.82 + level * 0.18);
      }

      // Dot halo — soft glow
      const halo = dotHaloRef.current;
      if (halo) {
        const haloAlpha = (0.18 + level * 0.22).toFixed(3);
        const haloBlur = 6 + level * 6;
        halo.style.boxShadow = `0 0 ${haloBlur}px rgba(var(--theme-accent-rgb), ${haloAlpha})`;
        halo.style.opacity = String(0.5 + level * 0.5);
      }

      // Track ring — subtle response: dimmer when arc is bright (contrast)
      const track = trackRef.current;
      if (track) {
        track.style.opacity = String(0.08 + level * 0.04);
      }

      // Icon — slight inverse scale on peaks
      const icon = iconRef.current;
      if (icon) {
        const iconScale = 1 - level * 0.08;
        icon.style.transform = `scale(${iconScale})`;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [showOrbit, isFinishing]);

  const handleClick = useCallback(() => {
    if (disabled && !isActive) return;

    void voiceRecordingService.toggle({
      panelId,
      panelTitle,
      projectId,
      projectName,
      worktreeId,
      worktreeLabel,
    });
  }, [disabled, isActive, panelId, panelTitle, projectId, projectName, worktreeId, worktreeLabel]);

  if (!isConfigured && !isActive) return null;

  return (
    <div
      className="relative flex items-center"
      style={{ contain: "strict", width: 24, height: 24 }}
    >
      {showOrbit && (
        <>
          {/* Static track — same mask technique as arc for consistent antialiasing */}
          <span
            ref={trackRef}
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              opacity: 0.08,
              background: `rgba(var(--theme-accent-rgb), 1)`,
              mask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
              WebkitMask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
              maskComposite: "exclude",
              WebkitMaskComposite: "xor",
              padding: `${BASE_THICKNESS}px`,
              transition: "opacity 80ms ease-out",
            }}
          />
          {/* Rotating wrapper */}
          <div
            ref={wrapperRef}
            className="absolute inset-0 pointer-events-none"
            style={{ willChange: "transform" }}
          >
            {/* Arc ring */}
            <span
              ref={ringRef}
              className="absolute inset-0 rounded-full"
              style={{
                padding: `${BASE_THICKNESS}px`,
                mask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
                WebkitMask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
                maskComposite: "exclude",
                WebkitMaskComposite: "xor",
              }}
            />
            {/* Dot: core (crisp) + halo (soft glow) */}
            <span
              ref={dotHaloRef}
              className="absolute rounded-full bg-daintree-accent/30"
              style={{
                width: "6px",
                height: "6px",
                top: 0,
                left: "50%",
                transform: "translate(-50%, -35%)",
              }}
            />
            <span
              ref={dotCoreRef}
              className="absolute rounded-full bg-daintree-accent"
              style={{
                width: "3.5px",
                height: "3.5px",
                top: 0,
                left: "50%",
                transform: "translate(-50%, -15%)",
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
          "relative flex items-center justify-center rounded-full transition duration-150",
          "h-6 w-6",
          "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent",
          showOrbit
            ? "bg-overlay-soft text-daintree-text hover:bg-overlay-medium"
            : cn(
                status === "error"
                  ? "text-activity-waiting hover:text-activity-waiting/80"
                  : "text-daintree-text/50 hover:text-daintree-text/80 hover:bg-tint/[0.06]"
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
        {isFinishing && !showOrbit ? (
          <Spinner size="sm" />
        ) : showOrbit ? (
          <span
            ref={iconRef}
            className="block h-2 w-2 rounded-[1.5px] bg-current transition-transform duration-100"
          />
        ) : (
          <Mic className="h-3.5 w-3.5 relative" />
        )}
      </button>
    </div>
  );
}
