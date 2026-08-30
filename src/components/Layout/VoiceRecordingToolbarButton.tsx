import { useEffect, useRef } from "react";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";

// Flywheel — matches VoiceInputButton so the toolbar and panel-header
// indicators behave identically.
const IDLE_SPEED = 72; // deg/sec — 1 revolution per 5s
const ACTIVE_SPEED = 288; // deg/sec — 1 revolution per 1.25s
const TAU_ATTACK = 0.22;
const TAU_RELEASE = 0.5;
const AUDIO_SMOOTH = 0.15;
const BASE_THICKNESS = 2; // px

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function VoiceRecordingPlaceholder() {
  // Reserves the slot footprint so right-aligned toolbar items don't shift
  // when a session starts/stops. Matches DevServerPlaceholder's pattern.
  // No data-toolbar-item — the placeholder is non-interactive and must not
  // appear in the toolbar's roving tabindex (Toolbar.getToolbarItems filters
  // by offsetParent, which opacity-0 does NOT null out).
  return (
    <div
      className="toolbar-icon-button relative mr-0.5 h-9 w-9 opacity-0 pointer-events-none"
      aria-hidden="true"
    />
  );
}

export function VoiceRecordingToolbarButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const activeTarget = useVoiceRecordingStore((state) => state.activeTarget);
  const status = useVoiceRecordingStore((state) => state.status);
  const elapsedSeconds = useVoiceRecordingStore((state) => state.elapsedSeconds);
  const shortcut = useKeybindingDisplay("voiceInput.toggle");
  const pauseShortcut = useKeybindingDisplay("voiceInput.togglePause");
  const ariaShortcut = useAriaKeyshortcuts("voiceInput.toggle");
  const hover = useShortcutHintHover("voiceInput.toggle");

  const isArming = status === "arming";
  const isConnecting = status === "connecting";
  const isRecording = status === "recording";
  const isReconnecting = status === "reconnecting";
  const isFinishing = status === "finishing";
  const isPaused = status === "paused";
  const isActive =
    Boolean(activeTarget) &&
    (isArming || isConnecting || isRecording || isReconnecting || isFinishing || isPaused);

  // Doherty gate — under 400ms of "connecting" should never paint the orbit;
  // it would flash before the recording state arrives.
  const showConnecting = useDohertyGate(isConnecting);
  // Gate the orbit on isActive too — protects against a transient teardown
  // race where status briefly stays "recording"/"finishing" while
  // activeTarget has already been cleared, which would otherwise leave the
  // RAF loop spinning on null refs.
  const showOrbit =
    isActive && (isRecording || isReconnecting || isFinishing || isPaused || showConnecting);
  // Arming paints immediately with no Doherty gate — the visual confirmation
  // IS the point of the state, and a gate would defeat it. The cue is a
  // static accent ring instead of the orbit (which only spins once audio
  // chunks land). Hold the static ring through the pre-Doherty connecting
  // window so the indicator never blanks out between the arming flash and
  // the orbit appearing.
  const showArming = isActive && (isArming || (isConnecting && !showConnecting));

  const wrapperRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const dotCoreRef = useRef<HTMLSpanElement>(null);
  const dotHaloRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!showOrbit) return;

    // Paused: freeze the ring at a dim static state. Skip the RAF loop so the
    // toolbar isn't redrawing 60 times a second while the user is thinking.
    if (isPaused) {
      const wrapper = wrapperRef.current;
      if (wrapper) wrapper.style.transform = `rotate(0deg) translateZ(0)`;
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

      // Force level to 0 during finishing so the ring decelerates gracefully.
      // Imperative store read: audioLevel updates ~60Hz during recording, so a
      // React subscription would re-render this button on every frame.
      const rawLevel = isFinishing ? 0 : useVoiceRecordingStore.getState().audioLevel;
      smoothLevel += (rawLevel - smoothLevel) * AUDIO_SMOOTH;
      const level = Math.pow(smoothLevel, 1.5);

      // Double-smoothed flywheel
      const targetVelocity = IDLE_SPEED + level * (ACTIVE_SPEED - IDLE_SPEED);
      const tau = targetVelocity > velocity ? TAU_ATTACK : TAU_RELEASE;
      const alpha = 1 - Math.exp(-dt / tau);
      v1 += (targetVelocity - v1) * alpha;
      velocity += (v1 - velocity) * alpha;
      angle = (angle + velocity * dt) % 360;

      const opacity = (0.45 + level * 0.55).toFixed(3);
      const opacityNum = Number(opacity);

      const wrapper = wrapperRef.current;
      if (wrapper) {
        wrapper.style.transform = `rotate(${angle}deg) translateZ(0)`;
      }

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

      const core = dotCoreRef.current;
      if (core) {
        core.style.opacity = String(0.82 + level * 0.18);
      }

      const halo = dotHaloRef.current;
      if (halo) {
        const haloAlpha = (0.18 + level * 0.22).toFixed(3);
        const haloBlur = 6 + level * 6;
        halo.style.boxShadow = `0 0 ${haloBlur}px rgb(from var(--theme-accent-primary) r g b / ${haloAlpha})`;
        halo.style.opacity = String(0.5 + level * 0.5);
      }

      const track = trackRef.current;
      if (track) {
        track.style.opacity = String(0.08 + level * 0.04);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [showOrbit, isFinishing, isPaused]);

  if (!isActive || (!showOrbit && !showArming)) {
    return <VoiceRecordingPlaceholder />;
  }

  const contextLabel = [activeTarget?.projectName, activeTarget?.worktreeLabel]
    .filter(Boolean)
    .join(" / ");
  const targetLabel = activeTarget?.panelTitle ?? contextLabel;
  const tooltipTitle = isArming
    ? targetLabel
      ? `Arming dictation: ${targetLabel}`
      : "Arming dictation..."
    : isConnecting
      ? "Preparing dictation..."
      : isReconnecting
        ? "Reconnecting..."
        : isFinishing
          ? "Finishing transcription..."
          : isPaused
            ? contextLabel
              ? `Paused: ${contextLabel}`
              : "Dictation paused"
            : contextLabel
              ? `Recording: ${contextLabel}`
              : "Recording in another panel";
  const tooltipExtra = (() => {
    const parts: Array<string | null> = [];
    if (isRecording || isPaused) parts.push(formatDuration(elapsedSeconds));
    if (isPaused) {
      // The toggle shortcut would start a new session when focused elsewhere;
      // the pause shortcut is the resume affordance the user actually wants.
      if (pauseShortcut) parts.push(`Press ${pauseShortcut} to resume`);
      else parts.push("Click to jump to panel");
    } else {
      parts.push(shortcut ? `Press ${shortcut} to stop` : "Click to jump to panel");
    }
    return parts.filter(Boolean).join(" · ");
  })();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              {...hover}
              variant="ghost"
              size="icon"
              data-toolbar-item={dataToolbarItem}
              onClick={() => {
                void voiceRecordingService.focusActiveTarget();
              }}
              className={cn(
                "toolbar-icon-button relative mr-0.5 text-text-primary",
                "hover:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))]"
              )}
              aria-label={tooltipTitle}
              aria-keyshortcuts={ariaShortcut}
            >
              <Mic className="h-4 w-4" />
              {/* Arming ring — static accent border painted during the
                  pre-audio confirmation window. Replaces the orbit until
                  audio is hot, so the user sees an immediate confirmation
                  that the hotkey was registered. */}
              {showArming && (
                <span
                  aria-hidden="true"
                  className="absolute inset-1 rounded-full pointer-events-none"
                  style={{
                    background: `var(--theme-accent-primary)`,
                    opacity: 0.55,
                    mask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
                    WebkitMask: `linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)`,
                    maskComposite: "exclude",
                    WebkitMaskComposite: "xor",
                    padding: `${BASE_THICKNESS}px`,
                  }}
                />
              )}
              {/* Orbit overlay — absolute inset on the relative Button. No
                  contain:strict at this scale: the toolbar button is a flex
                  child and clipping the orbit would crop the ring. */}
              {showOrbit && (
                <>
                  <span
                    ref={trackRef}
                    aria-hidden="true"
                    className="absolute inset-1 rounded-full pointer-events-none"
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
                  <div
                    ref={wrapperRef}
                    aria-hidden="true"
                    className="absolute inset-1 pointer-events-none"
                    style={{ willChange: "transform" }}
                  >
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
                      className="absolute rounded-full bg-accent-primary"
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
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-center">
            <div className="font-medium">{tooltipTitle}</div>
            {tooltipExtra && <div className="text-2xs text-text-secondary">{tooltipExtra}</div>}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId="voice-recording" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
