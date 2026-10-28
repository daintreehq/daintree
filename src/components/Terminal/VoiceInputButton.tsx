import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import { Mic, Play } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import { VOICE_ORBIT_MIN_OPACITY } from "@/utils/terminalTheme";
import { useVoiceRecordingStore, type CanopyReplyRow } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import type { VoiceInputError } from "@shared/types";
import {
  COMPOSER_CONTROL_FOCUS_CLASS,
  COMPOSER_CONTROL_HOVER_BG_CLASS,
  COMPOSER_CONTROL_TEXT_CLASS,
} from "./composerControlStyles";

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

// The orbit is the shell's contrast-fitted voice signal (`--ib-voice`), so it
// and the listening shell are one hue on every terminal palette.
const ORBIT_INK = "var(--ib-voice, var(--theme-accent-primary))";
// Every other ring is the composer's neutral control ink: only listening
// spends the accent.
const RING_INK = "color-mix(in oklab, var(--ib-fg) 72%, var(--ib-bg))";

/** A 2px band on the control's outer edge: the orbit's, the wait arc's, the held ring's. */
const RING_BAND: CSSProperties = {
  padding: `${BASE_THICKNESS}px`,
  mask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
  WebkitMask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
  maskComposite: "exclude",
  WebkitMaskComposite: "xor",
};

interface VoiceInputButtonProps {
  panelId: string;
  panelTitle?: string;
  projectId?: string;
  projectName?: string;
  worktreeId?: string;
  worktreeLabel?: string;
  /** A Canopy reply's: see `VoiceRecordingTarget`. */
  surface?: "canopy-reply";
  terminalId?: string;
  otherHostId?: string;
  canopyRow?: CanopyReplyRow;
  disabled?: boolean;
}

export function VoiceInputButton({
  panelId,
  panelTitle,
  projectId,
  projectName,
  worktreeId,
  worktreeLabel,
  surface,
  terminalId,
  otherHostId,
  canopyRow,
  disabled = false,
}: VoiceInputButtonProps) {
  const status = useVoiceRecordingStore((state) => state.status);
  const isConfigured = useVoiceRecordingStore((state) => state.isConfigured);
  const lastError = useVoiceRecordingStore((state) => state.lastError);
  const pauseStopWarning = useVoiceRecordingStore((state) => state.pauseStopWarning);
  const idleStopWarning = useVoiceRecordingStore((state) => state.idleStopWarning);
  const errorPanelId = useVoiceRecordingStore((state) => state.errorPanelId);
  const micSignal = useVoiceRecordingStore((state) => state.micSignal);
  const micDeviceLabel = useVoiceRecordingStore((state) => state.micDeviceLabel);
  const activePanelId = useVoiceRecordingStore((state) => state.activeTarget?.panelId ?? null);
  // A start aimed here that hasn't begun its session yet; a click ends it.
  const isPending = useVoiceRecordingStore((state) => state.pendingTarget?.panelId === panelId);

  const isRecording = activePanelId === panelId && status === "recording";
  const isConnecting = activePanelId === panelId && status === "connecting";
  const isReconnecting = activePanelId === panelId && status === "reconnecting";
  const isFinishing = activePanelId === panelId && status === "finishing";
  const isPaused = activePanelId === panelId && status === "paused";
  const hasError = status === "error" && errorPanelId === panelId;
  // Mic state and backend state are separate: the session is open (and a press
  // stops it) as soon as capture starts, but it only counts as listening once
  // the mic delivers real audio. Until then the orbit holds still (#13105).
  const isSessionOpen = isRecording || isConnecting || isReconnecting;
  const isListening = isSessionOpen && micSignal === "live";
  const isMicStarting = isSessionOpen && !isListening;
  const isActive = isSessionOpen || isFinishing || isPaused;
  // A click while the session finishes starts the next one (#14604), so a
  // disabled input blocks it like any other start.
  const blockedWhenDisabled = !isActive || isFinishing;
  // Only a session still feeding from the mic gets the orbit. Reconnecting is
  // not listening: speech past the provider's short reconnect buffer is lost.
  const isOrbiting = isListening && !isReconnecting;
  // Waiting on the machine (a start not yet open, the mic, the link, the last
  // words) spins a neutral arc; a pause the user chose holds a still ring.
  const isWaiting = isPending || isMicStarting || isReconnecting || isFinishing;

  // Animation refs
  const wrapperRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const dotCoreRef = useRef<HTMLSpanElement>(null);
  const dotHaloRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!isOrbiting) return;
    // The stop square outlives the orbit (reconnecting keeps it), so it gets
    // its resting size back when the orbit stops.
    const iconEl = iconRef.current;

    let lastTime = performance.now();
    let angle = 0;
    let v1 = IDLE_SPEED;
    let velocity = IDLE_SPEED;
    let smoothLevel = 0;

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      // Imperative store read: audioLevel updates ~60Hz during recording, so a
      // React subscription would re-render every mounted voice button per frame.
      const rawLevel = useVoiceRecordingStore.getState().audioLevel;

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
      // Reduced motion holds the arc still at its resting thickness; its
      // brightness still follows the voice. Read per frame so flipping either
      // preference mid-dictation takes effect at once.
      const still = prefersReducedMotion();
      const wrapper = wrapperRef.current;
      if (wrapper) {
        wrapper.style.transform = still
          ? `rotate(0deg) scale(${SCALE_MIN}) translateZ(0)`
          : `rotate(${angle}deg) scale(${scale}) translateZ(0)`;
      }

      // Refined gradient — exponential clustering near the head
      const ring = ringRef.current;
      if (ring) {
        ring.style.background = [
          `conic-gradient(from 0deg,`,
          `transparent 200deg,`,
          `rgb(from ${ORBIT_INK} r g b / ${(opacityNum * 0.05).toFixed(3)}) 248deg,`,
          `rgb(from ${ORBIT_INK} r g b / ${(opacityNum * 0.18).toFixed(3)}) 292deg,`,
          `rgb(from ${ORBIT_INK} r g b / ${(opacityNum * 0.42).toFixed(3)}) 326deg,`,
          `rgb(from ${ORBIT_INK} r g b / ${(opacityNum * 0.82).toFixed(3)}) 348deg,`,
          `rgb(from ${ORBIT_INK} r g b / ${opacity}) 355deg,`,
          `transparent 360deg)`,
        ].join(" ");
      }

      // Dot core — crisp, no blur
      const core = dotCoreRef.current;
      if (core) {
        core.style.opacity = String(
          VOICE_ORBIT_MIN_OPACITY + level * (1 - VOICE_ORBIT_MIN_OPACITY)
        );
      }

      // Dot halo — soft glow
      const halo = dotHaloRef.current;
      if (halo) {
        const haloAlpha = (0.18 + level * 0.22).toFixed(3);
        const haloBlur = 6 + level * 6;
        halo.style.boxShadow = `0 0 ${haloBlur}px rgb(from ${ORBIT_INK} r g b / ${haloAlpha})`;
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
        const iconScale = still ? 1 : 1 - level * 0.08;
        icon.style.transform = `scale(${iconScale})`;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (iconEl) iconEl.style.transform = "";
    };
  }, [isOrbiting]);

  const handleClick = useCallback(() => {
    if (disabled && blockedWhenDisabled) return;

    // Paused → resume on click; the affordance reads as a pause/resume toggle
    // rather than a stop. The dictation key stops and keeps the text; Escape
    // (handled by the service) cancels and discards it.
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
      ...(surface !== undefined ? { surface } : {}),
      ...(terminalId !== undefined ? { terminalId } : {}),
      ...(otherHostId !== undefined ? { otherHostId } : {}),
      ...(canopyRow !== undefined ? { canopyRow } : {}),
    });
  }, [
    disabled,
    blockedWhenDisabled,
    isPaused,
    panelId,
    panelTitle,
    projectId,
    projectName,
    worktreeId,
    worktreeLabel,
    surface,
    terminalId,
    otherHostId,
    canopyRow,
  ]);

  const tooltipText = !isConfigured
    ? "Configure voice input"
    : hasError
      ? formatVoiceErrorTooltip(lastError)
      : isPending
        ? "Starting microphone… Click to stop"
        : isFinishing
          ? disabled
            ? "Finishing transcription…"
            : "Finishing transcription… Click to start again"
          : isPaused
            ? pauseStopWarning
              ? "Paused — stops in 10s · Click to resume"
              : "Paused — click to resume"
            : isMicStarting
              ? micSignal === "silent"
                ? `No audio from ${micDeviceLabel ?? "microphone"} · Click to stop`
                : "Starting microphone… Click to stop"
              : isReconnecting
                ? "Reconnecting… Click to stop"
                : isListening
                  ? idleStopWarning
                    ? "Stopping in 10s unless you speak · Click to stop"
                    : "Stop recording"
                  : "Start voice input";

  return (
    <div
      className="relative flex items-center"
      // No paint containment: the orbit's halo reaches past the 24px box, and
      // clipping it there cut the glow square at every quarter turn.
      style={{ contain: "size layout style", width: 24, height: 24 }}
    >
      {/* The rings sit above the button: their band is the same outer 2px the
          inset keyboard ring uses, and the moving arc has to stay readable
          while the mic holds focus. */}
      {isOrbiting && (
        <>
          {/* Static track — same mask technique as arc for consistent antialiasing */}
          <span
            ref={trackRef}
            className="absolute inset-0 z-10 rounded-full pointer-events-none"
            data-voice-ring="orbit"
            style={{
              ...RING_BAND,
              opacity: 0.08,
              background: ORBIT_INK,
              transition: "opacity var(--duration-75) ease-out",
            }}
          />
          {/* Rotating wrapper */}
          <div
            ref={wrapperRef}
            className="absolute inset-0 z-10 pointer-events-none"
            style={{ willChange: "transform" }}
          >
            {/* Arc ring */}
            <span ref={ringRef} className="absolute inset-0 rounded-full" style={RING_BAND} />
            {/* Dot: core (crisp) + halo (soft glow) */}
            <span
              ref={dotHaloRef}
              className="absolute rounded-full"
              style={{
                width: "6px",
                height: "6px",
                top: BASE_THICKNESS / 2,
                left: "50%",
                transform: "translate(-50%, -50%)",
                background: `rgb(from ${ORBIT_INK} r g b / 0.3)`,
              }}
            />
            <span
              ref={dotCoreRef}
              className="absolute rounded-full"
              style={{
                width: "3.5px",
                height: "3.5px",
                top: BASE_THICKNESS / 2,
                left: "50%",
                transform: "translate(-50%, -50%)",
                background: ORBIT_INK,
              }}
            />
          </div>
        </>
      )}
      {isWaiting && (
        <>
          <span
            aria-hidden="true"
            className="absolute inset-0 z-10 rounded-full pointer-events-none"
            style={{ ...RING_BAND, background: RING_INK, opacity: 0.16 }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 z-10 rounded-full pointer-events-none animate-spin motion-reduce:animate-none"
            data-voice-ring="wait"
            style={{
              ...RING_BAND,
              background: `conic-gradient(${RING_INK} 0deg 100deg, transparent 100deg)`,
            }}
          />
        </>
      )}
      {isPaused && (
        <span
          aria-hidden="true"
          className="absolute inset-0 z-10 rounded-full pointer-events-none"
          data-voice-ring="held"
          style={{ ...RING_BAND, background: `var(--ib-voice-held, ${RING_INK})` }}
        />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            disabled={disabled && blockedWhenDisabled}
            className={cn(
              "relative flex items-center justify-center rounded-full transition-colors duration-150",
              "h-6 w-6",
              COMPOSER_CONTROL_FOCUS_CLASS,
              isActive || isPending
                ? "bg-[color-mix(in_oklab,var(--ib-fg)_12%,transparent)] text-[var(--ib-fg)] hover:bg-[color-mix(in_oklab,var(--ib-fg)_18%,transparent)]"
                : hasError
                  ? cn("text-activity-waiting", COMPOSER_CONTROL_HOVER_BG_CLASS)
                  : cn(COMPOSER_CONTROL_TEXT_CLASS, COMPOSER_CONTROL_HOVER_BG_CLASS)
            )}
            aria-label={
              !isConfigured
                ? "Set up voice input"
                : isPaused
                  ? "Resume voice recording"
                  : isSessionOpen || isPending
                    ? "Stop voice recording"
                    : "Start voice recording"
            }
            aria-pressed={isConfigured ? isSessionOpen || isPaused || isPending : undefined}
          >
            {/* The glyph is what a click does: stop an open session or a start
                still on its way, resume a paused one, start again once the
                last one is only finishing. */}
            {isPaused ? (
              <Play className="h-2.5 w-2.5 translate-x-[0.5px] fill-current" aria-hidden="true" />
            ) : isSessionOpen || isPending ? (
              <span
                ref={iconRef}
                className="status-mark block h-2 w-2 rounded-[1.5px] bg-current transition-transform duration-100"
              />
            ) : (
              <Mic className="h-3.5 w-3.5 relative" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltipText}</TooltipContent>
      </Tooltip>
    </div>
  );
}
