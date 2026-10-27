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

// The level meter's feel: a quick rise so a syllable registers at once, a
// slower fall so the bars don't flicker between words.
const TAU_ATTACK = 0.06; // sec
const TAU_RELEASE = 0.22; // sec
// Room noise sits around 0.02-0.04 on the store's level scale; below the
// floor the bars hold flat instead of twitching in silence.
const NOISE_FLOOR = 0.04;
const BAR_REST = 0.2; // scaleY in silence: a flat line, not empty
const WAVE_GAIN = 1.3; // so ordinary speech reaches the tallest bar's top

// Each bar's share of the level and its wobble, so the bars move apart
// rather than as one block. The middle bars carry the most.
const WAVE_BARS = [
  { weight: 0.6, rate: 7.1, phase: 0 },
  { weight: 1, rate: 9.3, phase: 1.7 },
  { weight: 0.85, rate: 8.2, phase: 3.1 },
  { weight: 0.55, rate: 10.4, phase: 4.6 },
] as const;
// The still shape: paused, and listening under reduced motion.
const STILL_SHAPE = [0.45, 0.8, 0.65, 0.4] as const;

// One width for every state the slot shows — placeholder, locked, elsewhere,
// and the mic with its waveform — so starting or ending a session never moves
// the right-aligned items.
const VOICE_SLOT_CLASS = "h-8 w-11";

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
          className={cn("toolbar-icon-button relative mr-0.5 text-text-secondary", VOICE_SLOT_CLASS)}
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
          className={cn("toolbar-icon-button relative mr-0.5 text-text-secondary", VOICE_SLOT_CLASS)}
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

type VoiceWaveMode = "level" | "waiting" | "held";

/**
 * The mic's small waveform. "level" follows the input level from a RAF loop
 * that writes the bars' transforms directly: audioLevel updates ~60Hz while
 * recording, and a React subscription would re-render the button every frame.
 * "waiting" (arming, the mic starting, reconnecting, finishing) is neutral
 * bars in a slow travelling fade; "held", a pause the user chose, is neutral
 * bars standing still. Nothing in the toolbar spins.
 */
function VoiceWave({ mode }: { mode: VoiceWaveMode }) {
  const barRefs = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    if (mode !== "level") return;

    let lastTime = performance.now();
    let smoothLevel = 0;
    let rafId = 0;

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      const rawLevel = useVoiceRecordingStore.getState().audioLevel;
      const gated = Math.max(0, (rawLevel - NOISE_FLOOR) / (1 - NOISE_FLOOR));
      const tau = gated > smoothLevel ? TAU_ATTACK : TAU_RELEASE;
      smoothLevel += (gated - smoothLevel) * (1 - Math.exp(-dt / tau));
      // Lift the quiet end so ordinary speech fills the bars.
      const level = Math.sqrt(smoothLevel);

      // Reduced motion holds the bars in one shape; their brightness still
      // follows the voice, so they stay a live level meter without moving.
      // Read per frame so flipping the preference mid-dictation applies at once.
      const still = prefersReducedMotion();
      const t = now / 1000;
      WAVE_BARS.forEach((bar, i) => {
        const el = barRefs.current[i];
        if (!el) return;
        const wobble = 0.75 + 0.25 * Math.sin(t * bar.rate + bar.phase);
        const scale = still
          ? STILL_SHAPE[i]!
          : BAR_REST + (1 - BAR_REST) * Math.min(1, WAVE_GAIN * level * bar.weight * wobble);
        el.style.transform = `scaleY(${scale.toFixed(3)})`;
        el.style.opacity = (0.55 + level * 0.45).toFixed(3);
      });

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [mode]);

  return (
    <span
      aria-hidden="true"
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-between pointer-events-none"
      data-voice-wave={mode}
    >
      {WAVE_BARS.map((bar, i) => (
        <span
          key={bar.phase}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className={cn(
            // Forced colours paints backgrounds as Canvas; the bars take text ink.
            "h-full w-0.5 rounded-full forced-colors:bg-[CanvasText]",
            mode === "level" ? "bg-accent-primary" : "bg-text-secondary",
            mode === "waiting" && "animate-voice-wave-wait motion-reduce:animate-none"
          )}
          style={{
            transform: `scaleY(${mode === "level" ? BAR_REST : mode === "held" ? STILL_SHAPE[i] : 0.35})`,
            opacity: mode === "level" ? 0.55 : mode === "held" ? 0.7 : undefined,
            animationDelay: mode === "waiting" ? `${i * 150}ms` : undefined,
          }}
        />
      ))}
    </span>
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
      className={cn(
        "toolbar-icon-button relative mr-0.5 opacity-0 pointer-events-none",
        VOICE_SLOT_CLASS
      )}
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

  // The waveform means "listening", so it waits for the mic to deliver real
  // audio — not for the transcription backend, which is a separate state
  // (captured audio is buffered while it connects). #13105.
  const isSessionOpen = isConnecting || isRecording || isReconnecting;
  const isMicLive = micSignal === "live";
  const isMicStarting = isSessionOpen && !isMicLive;
  // Gated on isActive too — protects against a transient teardown race where
  // status briefly stays "recording" while activeTarget has already been
  // cleared, which would otherwise start the level loop behind a placeholder.
  // Reconnecting and finishing are not listening, so they wait.
  const isListening = (isRecording || isConnecting) && isMicLive;
  const showLevel = !isQueued && isActive && isListening;
  const showHeld = !isQueued && isActive && isPaused;
  // Arming paints immediately — the visual confirmation IS the point of the
  // state. The waiting bars hold from the hotkey press until the mic is live,
  // so the indicator never blanks out before the level takes over.
  const showWaiting =
    isQueued || (isActive && (isArming || isMicStarting || isReconnecting || isFinishing));
  const waveMode: VoiceWaveMode | null = showLevel
    ? "level"
    : showHeld
      ? "held"
      : showWaiting
        ? "waiting"
        : null;

  if (!isActive || !waveMode) {
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
              "toolbar-icon-button relative mr-0.5 gap-1",
              VOICE_SLOT_CLASS,
              isPaused ? "text-text-secondary" : "text-text-primary",
              "hover:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))]"
            )}
            aria-label={tooltipTitle}
          >
            <Mic className="h-4 w-4" />
            <VoiceWave mode={waveMode} />
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
