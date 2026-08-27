import { useCallback, useEffect, useRef } from "react";
import { Mic } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import type { VoiceInputError } from "@shared/types";

/**
 * Maps a `VoiceInputError` to a concise tooltip string. Transient errors
 * (rate-limit, transport drop) surface a "reconnecting" nudge rather than an
 * alarming message — the mic button's orbital animation already signals the
 * in-progress retry. Fatal errors show the human-readable message fallback.
 */
function formatVoiceErrorTooltip(error: VoiceInputError | null): string {
  if (!error) return "Voice input error";
  const code = String(error.code);
  if (error.severity === "transient") {
    if (code === "rate_limit_exceeded") return "Rate limited — reconnecting";
    if (code.startsWith("ws_close_")) return "Connection dropped — reconnecting";
    return "Reconnecting…";
  }
  // Fatal — map known codes to actionable user-facing strings.
  if (code === "rate_limit_exceeded") return "Rate limit exceeded — check your API key quota";
  if (code === "reconnect_exhausted") return "Connection failed after several retries";
  if (code === "connection_timeout") return "Connection timed out";
  if (code.startsWith("ws_close_")) return `Connection closed — check network`;
  return error.message;
}

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
  const lastError = useVoiceRecordingStore((state) => state.lastError);
  const activePanelId = useVoiceRecordingStore((state) => state.activeTarget?.panelId ?? null);

  const isRecording = activePanelId === panelId && status === "recording";
  const isConnecting = activePanelId === panelId && status === "connecting";
  const isReconnecting = activePanelId === panelId && status === "reconnecting";
  const isFinishing = activePanelId === panelId && status === "finishing";
  const isPaused = activePanelId === panelId && status === "paused";
  const isListening = isRecording || isConnecting || isReconnecting;
  // Keep orbit visible through finishing and paused for continuity
  const showOrbit = isListening || isFinishing || isPaused;
  const isActive = isListening || isFinishing || isPaused;

  // Animation refs
  const wrapperRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const dotCoreRef = useRef<HTMLSpanElement>(null);
  const dotHaloRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!showOrbit) return;

    // Paused: freeze the orbit at a dim static state and skip the RAF loop
    // entirely. Burning CPU on an interpolating loop adds nothing while the
    // user is composing their next thought.
    if (isPaused) {
      const wrapper = wrapperRef.current;
      if (wrapper) {
        wrapper.style.transform = `rotate(0deg) scale(${SCALE_MIN}) translateZ(0)`;
      }
      const ring = ringRef.current;
      if (ring) {
        ring.style.background = [
          `conic-gradient(from 0deg,`,
          `transparent 200deg,`,
          `rgb(from var(--theme-accent-primary) r g b / 0.04) 280deg,`,
          `rgb(from var(--theme-accent-primary) r g b / 0.12) 340deg,`,
          `rgb(from var(--theme-accent-primary) r g b / 0.2) 360deg,`,
          `transparent 360deg)`,
        ].join(" ");
      }
      const core = dotCoreRef.current;
      if (core) core.style.opacity = "0.35";
      const halo = dotHaloRef.current;
      if (halo) {
        halo.style.boxShadow = "none";
        halo.style.opacity = "0.2";
      }
      const track = trackRef.current;
      if (track) track.style.opacity = "0.06";
      const icon = iconRef.current;
      if (icon) icon.style.transform = "scale(1)";
      return;
    }

    let lastTime = performance.now();
    let angle = 0;
    let v1 = IDLE_SPEED;
    let velocity = IDLE_SPEED;
    let smoothLevel = 0;

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      // During finishing, force level to 0 so it winds down gracefully.
      // Imperative store read: audioLevel updates ~60Hz during recording, so a
      // React subscription would re-render every mounted voice button per frame.
      const rawLevel = isFinishing ? 0 : useVoiceRecordingStore.getState().audioLevel;

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
          `rgb(from var(--theme-accent-primary) r g b / ${(opacityNum * 0.05).toFixed(3)}) 248deg,`,
          `rgb(from var(--theme-accent-primary) r g b / ${(opacityNum * 0.18).toFixed(3)}) 292deg,`,
          `rgb(from var(--theme-accent-primary) r g b / ${(opacityNum * 0.42).toFixed(3)}) 326deg,`,
          `rgb(from var(--theme-accent-primary) r g b / ${(opacityNum * 0.82).toFixed(3)}) 348deg,`,
          `rgb(from var(--theme-accent-primary) r g b / ${opacity}) 355deg,`,
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
        halo.style.boxShadow = `0 0 ${haloBlur}px rgb(from var(--theme-accent-primary) r g b / ${haloAlpha})`;
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
  }, [showOrbit, isFinishing, isPaused]);

  const handleClick = useCallback(() => {
    if (disabled && !isActive) return;

    // Paused → resume on click; the affordance reads as a pause/resume toggle
    // rather than a stop. Escape (handled by the service) is the cancel path.
    if (isPaused) {
      voiceRecordingService.togglePause();
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
    isPaused,
    panelId,
    panelTitle,
    projectId,
    projectName,
    worktreeId,
    worktreeLabel,
  ]);

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
              background: `var(--theme-accent-primary)`,
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
              ? formatVoiceErrorTooltip(lastError)
              : isFinishing
                ? "Finishing transcription..."
                : isPaused
                  ? "Paused — click to resume"
                  : isReconnecting
                    ? "Reconnecting... Click to stop"
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
            : isPaused
              ? "Resume voice recording"
              : isListening
                ? "Stop voice recording"
                : "Start voice recording"
        }
        aria-pressed={isConfigured ? isListening || isPaused : undefined}
      >
        {isFinishing && !showOrbit ? (
          <Spinner size="sm" />
        ) : isPaused ? (
          <span
            ref={iconRef}
            className="flex h-2.5 w-2.5 items-stretch justify-between"
            aria-hidden="true"
          >
            <span className="status-mark block w-[2px] rounded-[1px] bg-current opacity-70" />
            <span className="status-mark block w-[2px] rounded-[1px] bg-current opacity-70" />
          </span>
        ) : showOrbit ? (
          <span
            ref={iconRef}
            className="status-mark block h-2 w-2 rounded-[1.5px] bg-current transition-transform duration-100"
          />
        ) : (
          <Mic className="h-3.5 w-3.5 relative" />
        )}
      </button>
    </div>
  );
}
