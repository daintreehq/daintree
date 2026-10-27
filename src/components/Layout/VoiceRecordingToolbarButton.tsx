import { useEffect, useRef, type ReactNode } from "react";
import { Lock, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useEffectiveCombo, useShortcutHintHover } from "@/hooks";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { RecentDictationMenuItems } from "./RecentDictationMenuItems";
import { focusRecoveredComposer } from "@/services/recentDictationRecovery";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { isCanopyReplyTarget } from "@/services/canopyReplyDictation";
import { useScratchStore } from "@/store/scratchStore";
import { actionService } from "@/services/ActionService";
import { useHostList } from "@/components/Hosts/hostList";
import {
  namesSessionHost,
  sessionHostName,
  sessionPlacePhrase,
  sessionWorkspaceName,
} from "@/services/voiceSessionPlace";
import { isLocalHostId } from "@shared/types/remoteHosts";
import type { VoiceSessionElsewhere } from "@shared/types";

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

function VoiceLockedButton({
  label,
  "data-toolbar-item": dataToolbarItem,
}: {
  label: string;
  "data-toolbar-item"?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-toolbar-item={dataToolbarItem}
          onClick={() => {
            void actionService.dispatch("voiceInput.unlockTarget", undefined, {
              source: "user",
            });
          }}
          className="toolbar-icon-button relative mr-0.5 text-text-secondary"
          aria-label={`Dictation locked to ${label}. Click to unlock.`}
          data-testid="voice-locked-button"
        >
          <Lock className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{`Dictation locked to ${label}`}</span>
          <span className="text-text-secondary">Click to unlock</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

interface VoiceElsewhereButtonProps {
  session: VoiceSessionElsewhere;
  shortcut: string | undefined;
  "data-toolbar-item"?: string;
}

// Dictation another view owns: this view can't show its audio, only where it
// runs. The dictation key stops it from here. A session on another machine,
// or on this one while this view is on a host, names its host too (#14773).
function VoiceElsewhereButton(props: VoiceElsewhereButtonProps) {
  if (!isLocalHostId(props.session.hostId)) return <VoiceElsewhereOnHostButton {...props} />;
  const hostName = namesSessionHost(props.session)
    ? sessionHostName(props.session.hostId, [])
    : null;
  return <VoiceElsewhereIndicator {...props} hostName={hostName} />;
}

// Only a session on another machine needs the host list, for that host's name.
function VoiceElsewhereOnHostButton(props: VoiceElsewhereButtonProps) {
  const { hosts } = useHostList();
  return (
    <VoiceElsewhereIndicator {...props} hostName={sessionHostName(props.session.hostId, hosts)} />
  );
}

function VoiceElsewhereIndicator({
  session,
  shortcut,
  hostName,
  "data-toolbar-item": dataToolbarItem,
}: VoiceElsewhereButtonProps & { hostName: string | null }) {
  const scratches = useScratchStore((state) => state.scratches);
  const place = sessionPlacePhrase(sessionWorkspaceName(session, scratches), hostName);
  const title = place ? `Dictating${place}` : "Dictating elsewhere";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-toolbar-item={dataToolbarItem}
          onClick={() => {
            void voiceRecordingService.revealSessionElsewhere();
          }}
          className="toolbar-icon-button relative mr-0.5 text-text-secondary"
          aria-label={`${title}. Click to go there.`}
          data-testid="voice-elsewhere-button"
        >
          <Mic className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{title}</span>
          <span className="text-text-secondary">Click to go there</span>
          {shortcut && (
            <span className="text-text-secondary">{createTooltipContent("Stop", shortcut)}</span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The voice button's right-click menu, the same in every state it shows in:
 * whatever the state adds first, then the recent dictations, then the
 * toolbar's own items.
 */
function VoiceToolbarMenu({
  children,
  leadingItems,
}: {
  children: ReactNode;
  leadingItems?: ReactNode;
}) {
  // The composer an item just added text to. The menu's close would hand the
  // keyboard back to this button; the composer gets it instead.
  const insertedPanelRef = useRef<string | null>(null);
  return (
    <ContextMenu
      onOpenChange={(open) => {
        // A close the menu never finished (reopened mid-exit) must not carry
        // an earlier add's destination into this opening.
        if (open) insertedPanelRef.current = null;
      }}
    >
      <ContextMenuTrigger asChild>
        <span className="inline-flex">{children}</span>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          const panelId = insertedPanelRef.current;
          insertedPanelRef.current = null;
          if (!panelId) return;
          event.preventDefault();
          focusRecoveredComposer(panelId);
        }}
      >
        {leadingItems}
        <RecentDictationMenuItems
          onInserted={(panelId) => {
            insertedPanelRef.current = panelId;
          }}
        />
        <ToolbarContextMenuItems buttonId="voice-recording" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
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
  const lockedTarget = useVoiceRecordingStore((state) => state.lockedTarget);
  const pendingTarget = useVoiceRecordingStore((state) => state.pendingTarget);
  const sessionElsewhere = useVoiceRecordingStore((state) => state.sessionElsewhere);
  const status = useVoiceRecordingStore((state) => state.status);
  const elapsedSeconds = useVoiceRecordingStore((state) => state.elapsedSeconds);
  const micSignal = useVoiceRecordingStore((state) => state.micSignal);
  const micDeviceLabel = useVoiceRecordingStore((state) => state.micDeviceLabel);
  const pauseStopWarning = useVoiceRecordingStore((state) => state.pauseStopWarning);
  const idleStopWarning = useVoiceRecordingStore((state) => state.idleStopWarning);
  const shortcut = useEffectiveCombo("voiceInput.toggle");
  const pauseShortcut = useEffectiveCombo("voiceInput.togglePause");
  const hover = useShortcutHintHover("voiceInput.toggle");

  const isArming = status === "arming";
  const isConnecting = status === "connecting";
  const isRecording = status === "recording";
  const isReconnecting = status === "reconnecting";
  const isFinishing = status === "finishing";
  const isPaused = status === "paused";
  // A start waiting on a session that is still finishing (#14604). Single and
  // maximized panes paint no arming border, so the toolbar carries the cue.
  const isQueued = pendingTarget !== null && !isArming;
  const isActive =
    isQueued ||
    (Boolean(activeTarget) &&
      (isArming || isConnecting || isRecording || isReconnecting || isFinishing || isPaused));

  // The orbit means "listening", so it waits for the mic to deliver real
  // audio — not for the transcription backend, which is a separate state
  // (captured audio is buffered while it connects). #13105.
  const isSessionOpen = isConnecting || isRecording || isReconnecting;
  const isMicLive = micSignal === "live";
  const isMicStarting = isSessionOpen && !isMicLive;
  // Gate the orbit on isActive too — protects against a transient teardown
  // race where status briefly stays "recording"/"finishing" while
  // activeTarget has already been cleared, which would otherwise leave the
  // RAF loop spinning on null refs.
  // Reconnecting and finishing are not listening, so they get the static ring.
  const isListening = (isRecording || isConnecting) && isMicLive;
  const showOrbit = !isQueued && isActive && (isListening || isPaused);
  // Arming paints immediately — the visual confirmation IS the point of the
  // state. The static accent ring holds from the hotkey press until the mic
  // is live, so the indicator never blanks out before the orbit takes over.
  const showArming =
    isQueued || (isActive && (isArming || isMicStarting || isReconnecting || isFinishing));

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

      // Reduced motion holds the arc still; its brightness still follows the
      // voice, so the ring stays a live level meter without spinning. Read per
      // frame so flipping either preference mid-dictation takes effect at once.
      const wrapper = wrapperRef.current;
      if (wrapper) {
        const still = prefersReducedMotion();
        wrapper.style.transform = `rotate(${still ? 0 : angle}deg) translateZ(0)`;
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
    if (!isActive && sessionElsewhere) {
      return (
        <VoiceToolbarMenu>
          <VoiceElsewhereButton
            session={sessionElsewhere}
            shortcut={shortcut}
            data-toolbar-item={dataToolbarItem}
          />
        </VoiceToolbarMenu>
      );
    }
    if (!isActive && lockedTarget) {
      const lockedLabel =
        lockedTarget.panelTitle?.trim() ||
        [lockedTarget.projectName, lockedTarget.worktreeLabel].filter(Boolean).join(" / ") ||
        "a panel";
      return (
        <VoiceToolbarMenu>
          <VoiceLockedButton label={lockedLabel} data-toolbar-item={dataToolbarItem} />
        </VoiceToolbarMenu>
      );
    }
    return <VoiceRecordingPlaceholder />;
  }

  const labelTarget = isQueued ? pendingTarget : activeTarget;
  const contextLabel = [labelTarget?.projectName, labelTarget?.worktreeLabel]
    .filter(Boolean)
    .join(" / ");
  const panelLabel = labelTarget?.panelTitle?.trim();
  const targetLabel = panelLabel || contextLabel;
  const tooltipTitle =
    isArming || isQueued
      ? targetLabel
        ? `Arming dictation: ${targetLabel}`
        : "Arming dictation…"
      : isMicStarting
        ? micSignal === "silent"
          ? `No audio from ${micDeviceLabel ?? "microphone"}`
          : "Starting microphone…"
        : isConnecting
          ? targetLabel
            ? `Recording: ${targetLabel} · Connecting…`
            : "Recording · Connecting…"
          : isReconnecting
            ? "Reconnecting…"
            : isFinishing
              ? "Finishing transcription…"
              : isPaused
                ? pauseStopWarning
                  ? "Paused · Stopping in 10s unless resumed"
                  : targetLabel
                    ? `Paused: ${targetLabel}`
                    : "Dictation paused"
                : idleStopWarning
                  ? "Recording · Stopping in 10s unless you speak"
                  : targetLabel
                    ? `Recording: ${targetLabel}`
                    : "Recording in another panel";
  const elapsedLabel =
    !isQueued && (isRecording || isPaused) ? formatDuration(elapsedSeconds) : null;
  // The toggle shortcut would start a new session when focused elsewhere; the
  // pause shortcut is the resume affordance the user actually wants.
  const actionCombo = isPaused ? pauseShortcut : shortcut;

  return (
    <VoiceToolbarMenu
      leadingItems={
        (isRecording || isPaused) && (
          <>
            <ContextMenuItem onSelect={() => voiceRecordingService.togglePause()}>
              {isPaused ? "Resume dictation" : "Pause dictation"}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )
      }
    >
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
                    transition: "opacity var(--duration-75) ease-out",
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
        <TooltipContent side="bottom">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{tooltipTitle}</span>
            {panelLabel && contextLabel && (
              <span className="text-text-secondary">{contextLabel}</span>
            )}
            {elapsedLabel && <span className="text-text-secondary">{elapsedLabel}</span>}
            <span className="text-text-secondary">
              {isCanopyReplyTarget(labelTarget) ? "Click to go to reply" : "Click to jump to panel"}
            </span>
            {actionCombo && (
              <span className="text-text-secondary">
                {createTooltipContent(isPaused ? "Resume" : "Stop", actionCombo)}
              </span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </VoiceToolbarMenu>
  );
}
