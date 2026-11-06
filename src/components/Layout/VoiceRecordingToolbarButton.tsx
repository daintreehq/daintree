import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Clock, Lock, Mic, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { RecentDictationMenuItems } from "./RecentDictationMenuItems";
import { OwnVoiceSessionPanel } from "./OwnVoiceSessionPanel";
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
import type {
  VoiceInputStatus,
  VoiceMicSignal,
  VoiceSessionElsewhere,
  VoiceSessionSnapshot,
} from "@shared/types";
import { ElsewhereVoiceSessionPanel } from "./ElsewhereVoiceSessionPanel";
import { getElsewhereLevel } from "@/services/voiceElsewhereLevel";

// The level meter's envelope: a rise fast enough that a syllable registers at
// once, a fall that settles back to rest within a few hundred milliseconds of
// the voice stopping, so the bars never claim sound that has ended.
const TAU_ATTACK = 0.015; // sec
const TAU_RELEASE = 0.08; // sec
// Room noise sits around 0.02-0.04 on the store's level scale; below the
// floor the bars hold flat instead of twitching in silence.
const NOISE_FLOOR = 0.04;
const BAR_REST = 0.3; // scaleY in silence: short pills, still read as bars

// The bars show the envelope's recent history, newest on the right, one step
// apart, so speech travels across them instead of moving them as one block;
// the weights give the meter its shape.
const HISTORY_STEP = 0.07; // sec
// Longer than this between frames, the window was hidden and the history is stale.
const MAX_FRAME_GAP = 0.25; // sec
const WAVE_WEIGHTS = [0.6, 1, 0.8, 0.65] as const;
// Listening under reduced motion: one still shape at full ink.
const STILL_SHAPE = [0.45, 0.8, 0.65, 0.4] as const;

// One width for every state the slot shows — placeholder, locked, elsewhere,
// and the mic with its waveform — so starting or ending a session never moves
// the right-aligned items.
const VOICE_SLOT_CLASS = "h-8 w-11";

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
          className={cn("toolbar-icon-button relative text-text-secondary", VOICE_SLOT_CLASS)}
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

// The owner's indicator, read from what it reported: bars while its mic
// delivers, the pause glyph when held, the clock while it waits.
function elsewhereWaveMode(details: VoiceSessionSnapshot): VoiceWaveMode {
  switch (details.phase) {
    case "recording":
    case "connecting":
      return details.micSignal === "live" ? "level" : "waiting";
    case "paused":
      return "held";
    case "arming":
    case "reconnecting":
    case "finishing":
      return "waiting";
  }
}

/**
 * A running session's state in one line, the same for its owner's tooltip and
 * for every other view's (#14921).
 */
function voiceSessionTitle({
  phase,
  micSignal,
  micLabel,
  stopWarning,
}: {
  phase: VoiceInputStatus;
  micSignal: VoiceMicSignal;
  micLabel: string | null;
  stopWarning: boolean;
}): string {
  const isMicStarting =
    (phase === "connecting" || phase === "recording" || phase === "reconnecting") &&
    micSignal !== "live";
  if (phase === "arming") return "Arming dictation…";
  if (isMicStarting) {
    return micSignal === "silent"
      ? `No audio from ${micLabel ?? "microphone"}`
      : "Starting microphone…";
  }
  switch (phase) {
    case "connecting":
      return "Recording · Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "finishing":
      return "Finishing transcription…";
    case "paused":
      return stopWarning ? "Paused · Stopping in 10s unless resumed" : "Dictation paused";
    default:
      return stopWarning ? "Recording · Stopping in 10s unless you speak" : "Recording dictation";
  }
}

interface VoiceElsewhereButtonProps {
  session: VoiceSessionElsewhere;
  shortcut: string | undefined;
  "data-toolbar-item"?: string;
}

// Dictation another view owns, shown as the owner shows it from what the owner
// reports through main (#14921). The dictation key stops it from here. A
// session on another machine, or on this one while this view is on a host,
// names its host too (#14773).
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
  const pauseShortcut = useEffectiveCombo("voiceInput.togglePause");
  const hover = useShortcutHintHover("voiceInput.toggle");
  const place = sessionPlacePhrase(sessionWorkspaceName(session, scratches), hostName);
  const snapshot = session.details;
  // Until the owner's first report lands there is nothing to show but where
  // it runs, and a click goes there.
  if (!snapshot) {
    const title = `Dictating${place || " elsewhere"}`;
    return (
      <VoiceToolbarMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-toolbar-item={dataToolbarItem}
              onClick={() => {
                void voiceRecordingService.revealSessionElsewhere(session.sessionId);
              }}
              className={cn("toolbar-icon-button relative text-text-secondary", VOICE_SLOT_CLASS)}
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
                <span className="text-text-secondary">
                  {createTooltipContent("Stop", shortcut)}
                </span>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </VoiceToolbarMenu>
    );
  }

  const { sessionId } = session;
  const isPaused = snapshot.phase === "paused";
  const canPause = isPaused || snapshot.phase === "recording";
  const togglePause = () => {
    if (canPause) void voiceRecordingService.setSessionElsewherePaused(sessionId, !isPaused);
  };
  return (
    // Keyed by session, so a panel left open never carries into the next one.
    <VoiceSessionButton
      key={sessionId}
      // A state still under way reads on into where it runs.
      title={
        place
          ? `${voiceSessionTitle(snapshot).replace(/…$/, "")}${place}`
          : voiceSessionTitle(snapshot)
      }
      waveMode={elsewhereWaveMode(snapshot)}
      elsewhereSessionId={sessionId}
      isPaused={isPaused}
      canPause={canPause}
      onTogglePause={togglePause}
      shortcut={shortcut}
      pauseShortcut={pauseShortcut}
      hover={hover}
      testId="voice-elsewhere-button"
      data-toolbar-item={dataToolbarItem}
      renderPanel={({ leave, close }) => (
        <ElsewhereVoiceSessionPanel
          session={session}
          snapshot={snapshot}
          pauseShortcut={pauseShortcut}
          stopShortcut={shortcut}
          onGoToTarget={() => {
            leave();
            void voiceRecordingService.revealSessionElsewhere(sessionId);
          }}
          onTogglePause={togglePause}
          onStop={() => {
            close();
            void voiceRecordingService.stopSessionElsewhereById(sessionId);
          }}
        />
      )}
    />
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
  onOpen,
}: {
  children: ReactNode;
  leadingItems?: ReactNode;
  onOpen?: () => void;
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
        if (open) onOpen?.();
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

// The meter box's own size, inline because the button's `[&_svg]:size-4`
// outranks a size class on the glyph.
const METER_GLYPH_SIZE = { width: 14, height: 14 } as const;

/**
 * What sits beside the mic. "level" is four bars that follow the input level
 * from a RAF loop writing their transforms directly: audioLevel updates ~60Hz
 * while recording, and a React subscription would re-render the button every
 * frame. "waiting" (arming, the mic starting, reconnecting, finishing) is a
 * still clock: no bars, so it can't pass for a quiet room. "held", a pause the
 * user chose, is the pause glyph. Each state keeps its own shape where colour
 * is gone (forced colours), and nothing in the toolbar spins or pulses.
 */
function VoiceWave({
  mode,
  elsewhereSessionId,
}: {
  mode: VoiceWaveMode;
  /** Meter a session another view owns, from the level main relays (#14921). */
  elsewhereSessionId?: string;
}) {
  const barRefs = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    if (mode !== "level") return;

    let lastTime = performance.now();
    let envelope = 0;
    const history: Array<{ t: number; v: number }> = [];
    let rafId = 0;

    const tick = (now: number) => {
      // A frame's timestamp can precede the snapshot the loop started from.
      const gap = Math.max(0, (now - lastTime) / 1000);
      lastTime = now;

      const rawLevel = elsewhereSessionId
        ? getElsewhereLevel(elsewhereSessionId)
        : useVoiceRecordingStore.getState().audioLevel;
      const gated = Math.max(0, (rawLevel - NOISE_FLOOR) / (1 - NOISE_FLOOR));
      // Lift the quiet end before smoothing, so the envelope's timing is the
      // timing the eye sees.
      const target = Math.sqrt(gated);
      if (gap > MAX_FRAME_GAP) {
        // Frames stopped (a hidden window): what was heard before the gap is
        // stale, so start again from what is heard now.
        history.length = 0;
        envelope = target;
      } else {
        const tau = target > envelope ? TAU_ATTACK : TAU_RELEASE;
        envelope += (target - envelope) * (1 - Math.exp(-gap / tau));
      }

      const t = now / 1000;
      history.push({ t, v: envelope });
      const horizon = t - HISTORY_STEP * WAVE_WEIGHTS.length;
      while (history.length > 1 && history[1]!.t <= horizon) history.shift();
      const at = (lag: number) => {
        for (let k = history.length - 1; k >= 0; k--) {
          if (history[k]!.t <= t - lag) return history[k]!.v;
        }
        return 0;
      };

      // Reduced motion holds one still shape. Read per frame so flipping the
      // preference mid-dictation applies at once.
      const still = prefersReducedMotion();
      WAVE_WEIGHTS.forEach((weight, i) => {
        const el = barRefs.current[i];
        if (!el) return;
        const level = at((WAVE_WEIGHTS.length - 1 - i) * HISTORY_STEP);
        const scale = still
          ? STILL_SHAPE[i]!
          : BAR_REST + (1 - BAR_REST) * Math.min(1, level * weight);
        el.style.transform = `scaleY(${scale.toFixed(3)})`;
      });

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [mode, elsewhereSessionId]);

  return (
    <span
      aria-hidden="true"
      // The ink sits on the wrapper so the glyph inherits it: forced colours
      // repaints an inherited currentColor, not one set on the svg itself.
      className={cn(
        "flex h-3.5 w-3.5 shrink-0 items-center justify-between pointer-events-none",
        mode !== "level" && "text-text-secondary"
      )}
      data-voice-wave={mode}
    >
      {mode === "waiting" && <Clock style={METER_GLYPH_SIZE} />}
      {mode === "held" && <Pause style={METER_GLYPH_SIZE} />}
      {mode === "level" &&
        WAVE_WEIGHTS.map((_, i) => (
          <span
            key={i}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
            className="h-full w-0.5 rounded-full bg-text-primary"
            style={{ transform: `scaleY(${BAR_REST})` }}
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
      className={cn("toolbar-icon-button relative opacity-0 pointer-events-none", VOICE_SLOT_CLASS)}
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
  const micSignal = useVoiceRecordingStore((state) => state.micSignal);
  const micDeviceLabel = useVoiceRecordingStore((state) => state.micDeviceLabel);
  const pauseStopWarning = useVoiceRecordingStore((state) => state.pauseStopWarning);
  const idleStopWarning = useVoiceRecordingStore((state) => state.idleStopWarning);
  const shortcut = useEffectiveCombo("voiceInput.toggle");
  const pauseShortcut = useEffectiveCombo("voiceInput.togglePause");
  const sendShortcut = useEffectiveCombo("voiceInput.stopAndSend");
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
        <VoiceElsewhereButton
          session={sessionElsewhere}
          shortcut={shortcut}
          data-toolbar-item={dataToolbarItem}
        />
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

  // Arming and a queued start keep their jump: there is no session yet for a
  // panel to show.
  if (isQueued || isArming) {
    const labelTarget = isQueued ? pendingTarget : activeTarget;
    const contextLabel = [labelTarget?.projectName, labelTarget?.worktreeLabel]
      .filter(Boolean)
      .join(" / ");
    const panelLabel = labelTarget?.panelTitle?.trim();
    const targetLabel = panelLabel || contextLabel;
    const armingTitle = targetLabel ? `Arming dictation: ${targetLabel}` : "Arming dictation…";
    return (
      <VoiceToolbarMenu>
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
                "toolbar-icon-button toolbar-live-control relative gap-1",
                VOICE_SLOT_CLASS
              )}
              aria-label={armingTitle}
            >
              <Mic className="h-4 w-4" />
              <VoiceWave mode={waveMode} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{armingTitle}</span>
              {panelLabel && contextLabel && (
                <span className="text-text-secondary">{contextLabel}</span>
              )}
              <span className="text-text-secondary">
                {isCanopyReplyTarget(labelTarget)
                  ? "Click to go to reply"
                  : "Click to jump to panel"}
              </span>
              {shortcut && (
                <span className="text-text-secondary">
                  {createTooltipContent("Stop", shortcut)}
                </span>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </VoiceToolbarMenu>
    );
  }

  // The tooltip is one line of state; everything else is in the panel.
  const tooltipTitle = voiceSessionTitle({
    phase: status,
    micSignal,
    micLabel: micDeviceLabel,
    stopWarning: isPaused ? pauseStopWarning : idleStopWarning,
  });

  return (
    <VoiceSessionButton
      title={tooltipTitle}
      waveMode={waveMode}
      isPaused={isPaused}
      canPause={isRecording || isPaused}
      onTogglePause={() => voiceRecordingService.togglePause()}
      shortcut={shortcut}
      pauseShortcut={pauseShortcut}
      hover={hover}
      testId="voice-session-button"
      data-toolbar-item={dataToolbarItem}
      renderPanel={({ leave, close }) => (
        <OwnVoiceSessionPanel
          pauseShortcut={pauseShortcut}
          stopShortcut={shortcut}
          onGoToTarget={() => {
            leave();
            void voiceRecordingService.goToActiveTarget();
          }}
          onTogglePause={() => voiceRecordingService.togglePause()}
          sendShortcut={sendShortcut}
          onStop={() => {
            // The stop takes the keyboard back to the dictation, as its key does.
            leave();
            void voiceRecordingService.stopActiveSession();
          }}
          onSend={() => {
            close();
            void voiceRecordingService.stopAndSend({ asker: "session_panel_send" });
          }}
        />
      )}
    />
  );
}

interface VoiceSessionButtonProps {
  title: string;
  waveMode: VoiceWaveMode;
  /** Meters a session another view owns, from the level main relays (#14921). */
  elsewhereSessionId?: string;
  isPaused: boolean;
  canPause: boolean;
  onTogglePause: () => void;
  shortcut: string | undefined;
  pauseShortcut: string | undefined;
  hover: ReturnType<typeof useShortcutHintHover>;
  testId: string;
  "data-toolbar-item"?: string;
  /**
   * The panel, given how to close it: `leave` when the action takes the
   * keyboard somewhere else, so the close doesn't hand it back to the mic.
   */
  renderPanel: (actions: { leave: () => void; close: () => void }) => ReactNode;
}

/**
 * The mic while a session runs, here or in another view: a click opens the
 * session panel (#14920, #14921). Mounted only while there is a session, so a
 * closed session's open state never carries into the next one.
 */
// A toolbar item the keyboard can land on now: still there, enabled, and
// shown (an item folded into the overflow menu has no layout).
function canTakeFocus(item: HTMLElement): boolean {
  return item.isConnected && !item.matches(":disabled") && item.offsetParent !== null;
}

// What can take the slot when a session ends: the lock's button or another
// view's session.
const VOICE_SLOT_SUCCESSOR_SELECTOR =
  '[data-testid="voice-locked-button"], [data-testid="voice-elsewhere-button"]';

function VoiceSessionButton({
  title,
  waveMode,
  elsewhereSessionId,
  isPaused,
  canPause,
  onTogglePause,
  shortcut,
  pauseShortcut,
  hover,
  testId,
  "data-toolbar-item": dataToolbarItem,
  renderPanel,
}: VoiceSessionButtonProps) {
  const [open, setOpen] = useState(false);
  // Going to the target moves the keyboard there, so the close must not
  // hand it back to the mic. Each opening starts without it: a close the
  // exit never finished doesn't decide the next one.
  const leavingRef = useRef(false);
  // The keyboard is on the mic or in its panel. A session that ends under it
  // takes both away, so the keyboard goes to whatever takes the slot.
  const holdsFocusRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // The toggle shortcut would start a new session when focused elsewhere; the
  // pause shortcut is the resume affordance the user actually wants.
  const actionCombo = isPaused ? pauseShortcut : shortcut;

  // A layout cleanup, so the focused element is still in the document: whether
  // it shows its ring now decides whether the successor shows one.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const toolbar = trigger?.closest('[role="toolbar"]') ?? null;
    return () => {
      if (!holdsFocusRef.current || !toolbar || !trigger) return;
      const visible = document.activeElement?.matches(":focus-visible") ?? false;
      // The placeholder takes no focus, so a slot nothing takes hands it to
      // the nearest toolbar item, ordered while the mic is still among them.
      const items = Array.from(toolbar.querySelectorAll<HTMLElement>("[data-toolbar-item]"));
      const at = items.indexOf(trigger);
      const neighbours =
        at < 0
          ? []
          : items
              .map((item, i) => ({ item, distance: Math.abs(i - at) }))
              .filter(({ distance }) => distance > 0)
              .sort((a, b) => a.distance - b.distance)
              .map(({ item }) => item);
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const successor =
          toolbar.querySelector<HTMLElement>(VOICE_SLOT_SUCCESSOR_SELECTOR) ??
          neighbours.find(canTakeFocus) ??
          null;
        if (!successor) return;
        // A pointer user didn't ask for the successor's tooltip either.
        if (!visible) armTooltipFocusSuppression();
        successor.focus({ preventScroll: true, focusVisible: visible });
      });
    };
  }, []);

  const focusHandlers = {
    onFocus: () => {
      holdsFocusRef.current = true;
    },
    onBlur: () => {
      holdsFocusRef.current = false;
    },
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) leavingRef.current = false;
        setOpen(next);
      }}
      modal={false}
    >
      <VoiceToolbarMenu
        onOpen={() => setOpen(false)}
        leadingItems={
          canPause && (
            <>
              <ContextMenuItem onSelect={onTogglePause}>
                {isPaused ? "Resume dictation" : "Pause dictation"}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )
        }
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                {...hover}
                onFocus={(event) => {
                  focusHandlers.onFocus();
                  hover.onFocus(event);
                }}
                onBlur={() => {
                  focusHandlers.onBlur();
                  hover.onBlur();
                }}
                ref={triggerRef}
                variant="ghost"
                size="icon"
                data-toolbar-item={dataToolbarItem}
                className={cn(
                  "toolbar-icon-button relative gap-1",
                  VOICE_SLOT_CLASS,
                  !isPaused && "toolbar-live-control"
                )}
                aria-label={title}
                data-testid={testId}
              >
                <Mic className="h-4 w-4" />
                <VoiceWave mode={waveMode} elsewhereSessionId={elsewhereSessionId} />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{title}</span>
              {actionCombo && (
                <span className="text-text-secondary">
                  {createTooltipContent(isPaused ? "Resume" : "Stop", actionCombo)}
                </span>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </VoiceToolbarMenu>
      <PopoverContent
        side="bottom"
        align="end"
        // A short window scrolls the panel rather than cutting its actions off.
        className="max-h-[var(--radix-popover-content-available-height)] w-auto overflow-y-auto p-0"
        aria-label="Dictation session"
        {...focusHandlers}
        onCloseAutoFocus={(event) => {
          if (!leavingRef.current) return;
          leavingRef.current = false;
          event.preventDefault();
        }}
      >
        <VoiceSessionPanelSlot
          renderPanel={renderPanel}
          leave={() => {
            leavingRef.current = true;
            setOpen(false);
          }}
          close={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

// Hands `leave` to the panel as a prop. Built inside a `renderPanel` call made
// during render, its ref write reads to React Compiler as a ref accessed in
// render, which the dev server's panic threshold turns into a failed module
// (#15391).
function VoiceSessionPanelSlot({
  renderPanel,
  leave,
  close,
}: {
  renderPanel: VoiceSessionButtonProps["renderPanel"];
  leave: () => void;
  close: () => void;
}) {
  return renderPanel({ leave, close });
}
