import { useEffect, useId, useRef, type ReactNode } from "react";
import { ChevronRight, CornerDownLeft, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { POPOVER_ROW_HOVER_CLASS } from "@/components/ui/popoverHeader";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { SEVERITY_VISUAL } from "@/lib/statusSeverity";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import type { TerminalChromeDescriptor } from "@/utils/terminalChrome";
import type { VoiceMicSignal } from "@/store/voiceRecordingStore";

/** The states a session shows its panel in. */
export type VoiceSessionPhase =
  "arming" | "connecting" | "recording" | "paused" | "reconnecting" | "finishing";

/** What the session is recording: words for the draft, a rewrite instruction, or a Canopy reply. */
export type VoiceSessionKind = "dictation" | "rewrite" | "canopy-reply";

/**
 * Everything the panel shows about one dictation session, as plain data: the
 * view that owns the session reads it from its store and service, and a view
 * that doesn't (#14921) from what the owner publishes.
 */
export interface VoiceSessionDetails {
  phase: VoiceSessionPhase;
  kind: VoiceSessionKind;
  /** The terminal (or reply) the words go to, as its header names it. */
  targetTitle: string;
  /** The target's identity for its icon; null draws the plain terminal glyph. */
  targetChrome: TerminalChromeDescriptor | null;
  hostName: string | null;
  projectName: string | null;
  worktreeLabel: string | null;
  micLabel: string | null;
  micSignal: VoiceMicSignal;
  micNotice: { kind: "lost" | "silent"; bluetooth: boolean } | null;
  providerName: string | null;
  /** Wall time since the session began, pauses included; null before it has begun or once it stops. */
  elapsedMs: number | null;
  pausedMs: number;
  autoStop: { reason: "pause" | "idle"; remainingMs: number } | null;
  correctionEnabled: boolean;
  locked: boolean;
  wordCount: number;
  /** The words so far, the newest last. */
  transcript: string;
}

export interface VoiceSessionPanelProps {
  details: VoiceSessionDetails;
  /** The input level on the store's 0-1 scale, read once per frame by the meter. */
  readLevel: () => number;
  pauseShortcut?: string;
  stopShortcut?: string;
  onGoToTarget: () => void;
  onTogglePause: () => void;
  onStop: () => void;
  /**
   * Stop, and send the draft from its composer without going there. Left out
   * where the view can't send for the session; a rewrite instruction has
   * nothing to send.
   */
  onSend?: () => void;
  /** Whether the composer is there to send from right now. */
  canSend?: boolean;
  sendShortcut?: string;
  /** What Stop says: a view that stops without going anywhere says only that. */
  stopLabel?: string;
}

// Enough for three lines at the panel's width: what was just heard, never
// the whole draft.
const TRANSCRIPT_TAIL_CHARS = 240;
// The meter's floor and smoothing, matched to the toolbar's bars so the two
// agree on what counts as sound.
const NOISE_FLOOR = 0.04;
const TAU_ATTACK = 0.015;
const TAU_RELEASE = 0.08;
const METER_SEGMENTS = 10;
// The last stretch before an auto-stop, when its line steps up to primary ink.
const AUTO_STOP_SOON_MS = 10_000;

function formatClock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function hasNoAudio({ micSignal, micNotice }: VoiceSessionDetails): boolean {
  return micSignal === "silent" || micNotice?.kind === "silent" || micNotice?.kind === "lost";
}

function phaseLabel(details: VoiceSessionDetails): string {
  const { phase, micSignal, micNotice, providerName } = details;
  switch (phase) {
    case "arming":
      return "Arming";
    case "connecting":
    case "recording":
      if (micNotice?.kind === "lost") return "Microphone disconnected";
      if (hasNoAudio(details)) return "No audio";
      return micSignal === "live" ? "Listening" : "Starting microphone";
    case "paused":
      return "Paused";
    case "reconnecting":
      return providerName ? `Reconnecting to ${providerName}` : "Reconnecting";
    case "finishing":
      return "Finishing transcription";
  }
}

/** What is wrong with the mic, when something is. */
function micProblem(details: VoiceSessionDetails): string | null {
  const { phase, micLabel, micNotice } = details;
  const mic = micLabel ?? "the microphone";
  if (phase !== "connecting" && phase !== "recording") return null;
  if (micNotice?.kind === "lost") return `${mic} stopped delivering audio`;
  if (!hasNoAudio(details)) return null;
  return micNotice?.bluetooth
    ? `Nothing heard from ${mic}. Bluetooth mics can take a moment to start.`
    : `Nothing heard from ${mic}. Check the selected microphone.`;
}

/** The line under the state: what is under way, and what happens next. */
function phaseDetail(details: VoiceSessionDetails): string | null {
  const { phase, micSignal, providerName, pausedMs, autoStop } = details;
  const parts: string[] = [];
  if (phase === "connecting" && micSignal === "live" && providerName) {
    parts.push(`Connecting to ${providerName}`);
  }
  if (phase === "paused" && pausedMs >= 1000) parts.push(`Paused ${formatClock(pausedMs)}`);
  if (autoStop) {
    const remaining = formatClock(autoStop.remainingMs);
    parts.push(
      autoStop.reason === "pause"
        ? `Stops in ${remaining} unless resumed`
        : `Stops in ${remaining} without new words`
    );
  }
  return parts.length ? parts.join(" · ") : null;
}

const KIND_LABEL: Record<VoiceSessionKind, string> = {
  dictation: "Dictation",
  rewrite: "Rewrite instruction",
  "canopy-reply": "Canopy reply",
};

function micStatus(details: VoiceSessionDetails): string {
  const { phase, micSignal, micNotice } = details;
  if (phase === "paused") return "Paused";
  if (phase === "finishing") return "Stopped";
  if (micNotice?.kind === "lost") return "Disconnected";
  if (hasNoAudio(details)) return micNotice?.bluetooth ? "No audio · Bluetooth" : "No audio";
  return micSignal === "live" ? "Delivering audio" : "Waiting for audio";
}

/**
 * The input level as a row of segments lit from the left, written from a RAF
 * loop straight to their opacity so the panel never re-renders per frame.
 * Segments rather than one bar, so it can't read as progress.
 */
function VoiceSessionLevel({ readLevel }: { readLevel: () => number }) {
  const segmentRefs = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    let last = performance.now();
    let envelope = 0;
    let rafId = 0;
    const tick = (now: number) => {
      const gap = Math.max(0, (now - last) / 1000);
      last = now;
      const gated = Math.max(0, (readLevel() - NOISE_FLOOR) / (1 - NOISE_FLOOR));
      const target = Math.sqrt(gated);
      if (prefersReducedMotion()) {
        envelope = target;
      } else {
        const tau = target > envelope ? TAU_ATTACK : TAU_RELEASE;
        envelope += (target - envelope) * (1 - Math.exp(-gap / tau));
      }
      const lit = Math.round(Math.min(1, envelope) * METER_SEGMENTS);
      segmentRefs.current.forEach((segment, i) => {
        if (segment) segment.dataset.lit = i < lit ? "true" : "false";
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [readLevel]);

  return (
    <span
      aria-hidden="true"
      className="flex h-3 items-center gap-0.5"
      data-testid="voice-session-level"
    >
      {Array.from({ length: METER_SEGMENTS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            segmentRefs.current[i] = el;
          }}
          data-lit="false"
          className="h-full w-1 rounded-full bg-overlay-strong data-[lit=true]:bg-text-primary forced-colors:bg-[GrayText] forced-colors:data-[lit=true]:bg-[CanvasText]"
        />
      ))}
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="min-w-0 break-words text-text-secondary">{children}</dd>
    </div>
  );
}

/**
 * The toolbar mic's control panel for a live dictation (#14920): where the
 * words go, what the session is doing, what it has heard, its pause and stop,
 * and then everything else known about it.
 */
export function VoiceSessionPanel({
  details,
  readLevel,
  pauseShortcut,
  stopShortcut,
  onGoToTarget,
  onTogglePause,
  onStop,
  onSend,
  canSend = false,
  sendShortcut,
  stopLabel = "Stop and return",
}: VoiceSessionPanelProps) {
  const {
    phase,
    kind,
    targetTitle,
    targetChrome,
    hostName,
    projectName,
    worktreeLabel,
    micLabel,
    micSignal,
    providerName,
    elapsedMs,
    autoStop,
    correctionEnabled,
    locked,
    wordCount,
    transcript,
  } = details;
  const isPaused = phase === "paused";
  const canPause = phase === "recording" || isPaused;
  const canStop = phase !== "finishing";
  const showSend = onSend !== undefined && kind !== "rewrite";
  const noAudio = (phase === "connecting" || phase === "recording") && hasNoAudio(details);
  const levelActive =
    (phase === "recording" || phase === "connecting" || phase === "reconnecting") &&
    micSignal === "live" &&
    !noAudio;
  const place = [hostName, projectName, worktreeLabel].filter(Boolean).join(" · ");
  const problem = micProblem(details);
  const detail = phaseDetail(details);
  const placeId = useId();
  const sendNoteId = useId();
  // Send there but not possible right now: Stop is the action left to make.
  const sendBlocked = showSend && !canSend && phase !== "finishing";
  const stopIsPrimary = !showSend || sendBlocked;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusedRef = useRef<Element | null>(null);

  // A phase change can disable the control the keyboard is on (Pause while
  // reconnecting, everything while finishing), which drops focus to the
  // page; the top row, always there, takes it instead.
  useEffect(() => {
    const last = lastFocusedRef.current;
    if (!(last instanceof HTMLButtonElement) || !last.disabled) return;
    if (!rootRef.current?.contains(last)) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== last) return;
    targetRef.current?.focus({ preventScroll: true });
  }, [phase, canSend]);
  const stopsSoon = autoStop !== null && autoStop.remainingMs <= AUTO_STOP_SOON_MS;
  const tail =
    transcript.length > TRANSCRIPT_TAIL_CHARS
      ? `…${transcript.slice(-TRANSCRIPT_TAIL_CHARS).trimStart()}`
      : transcript;
  const WarningIcon = SEVERITY_VISUAL.warning.Icon;

  return (
    <div
      ref={rootRef}
      className="flex w-80 flex-col"
      data-testid="voice-session-panel"
      data-phase={phase}
      onFocus={(event) => {
        lastFocusedRef.current = event.target;
      }}
    >
      <button
        ref={targetRef}
        type="button"
        onClick={onGoToTarget}
        className={cn(
          "flex items-center gap-2.5 px-3 py-2.5 text-left outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
          POPOVER_ROW_HOVER_CLASS
        )}
        aria-label={`Go to ${targetTitle}`}
        aria-describedby={place ? placeId : undefined}
        data-testid="voice-session-target"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center self-start pt-0.5 text-text-secondary">
          <TerminalIcon chrome={targetChrome ?? undefined} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 break-words text-sm font-medium text-text-primary">
            {targetTitle}
          </span>
          {place && (
            <span
              id={placeId}
              className="break-words text-xs text-text-secondary"
              data-testid="voice-session-place"
            >
              {place}
            </span>
          )}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
      </button>

      <div className="flex flex-col gap-1 border-t border-divider px-3 py-2.5">
        <div className="flex items-center gap-2">
          {noAudio && (
            <WarningIcon
              className={cn("h-3.5 w-3.5 shrink-0", SEVERITY_VISUAL.warning.toneClass)}
              aria-hidden="true"
            />
          )}
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary"
            data-testid="voice-session-state"
          >
            {phaseLabel(details)}
          </span>
          {levelActive && <VoiceSessionLevel readLevel={readLevel} />}
          {elapsedMs !== null && (
            <span
              className="shrink-0 text-xs tabular-nums text-text-secondary"
              data-testid="voice-session-elapsed"
            >
              {formatClock(elapsedMs)}
            </span>
          )}
        </div>
        {problem && (
          <span className="text-xs text-text-secondary" data-testid="voice-session-problem">
            {problem}
          </span>
        )}
        {detail && (
          <span
            className={cn(
              "text-xs",
              stopsSoon ? "font-medium text-text-primary" : "text-text-secondary"
            )}
            data-testid="voice-session-detail"
          >
            {detail}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1 border-t border-divider px-3 py-2.5">
        <span className="text-xs text-text-secondary" data-testid="voice-session-words">
          {pluralize(wordCount, "word")}
        </span>
        {tail ? (
          <div className="flex max-h-[3.75rem] flex-col justify-end overflow-hidden">
            <p
              className="break-words text-xs leading-5 text-text-primary select-text"
              data-testid="voice-session-transcript"
            >
              {tail}
            </p>
          </div>
        ) : (
          <span className="text-xs text-text-secondary">Nothing heard yet</span>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-divider px-3 py-2.5">
        {showSend && (
          <Button
            variant="contrast"
            size="sm"
            className="w-full"
            onClick={onSend}
            disabled={!canSend || phase === "finishing"}
            aria-describedby={sendBlocked ? sendNoteId : undefined}
            data-testid="voice-session-send"
          >
            <CornerDownLeft />
            Stop and send
            {sendShortcut && (
              <KbdChord
                shortcut={sendShortcut}
                density="compact"
                foreground="inverse"
                className="ml-auto"
              />
            )}
          </Button>
        )}
        {sendBlocked && (
          <span
            id={sendNoteId}
            className="text-xs text-text-secondary"
            data-testid="voice-session-send-note"
          >
            Its composer isn't open, so it can't send from here
          </span>
        )}
        {/* Wraps when spelled-out shortcuts (Ctrl+Shift+Space) need the room. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="flex-[1_1_auto] justify-start"
            onClick={onTogglePause}
            disabled={!canPause}
            data-testid="voice-session-pause"
          >
            {isPaused ? <Play /> : <Pause />}
            {isPaused ? "Resume" : "Pause"}
            {pauseShortcut && (
              <KbdChord shortcut={pauseShortcut} density="compact" className="ml-auto" />
            )}
          </Button>
          <Button
            variant={stopIsPrimary ? "contrast" : "ghost"}
            size="sm"
            className="flex-[1_1_auto] justify-start"
            onClick={onStop}
            disabled={!canStop}
            data-testid="voice-session-stop"
          >
            <Square className="fill-current" />
            {stopLabel}
            {stopShortcut && (
              <KbdChord
                shortcut={stopShortcut}
                density="compact"
                foreground={stopIsPrimary ? "inverse" : "secondary"}
                className="ml-auto"
              />
            )}
          </Button>
        </div>
      </div>

      <dl className="flex flex-col gap-1 border-t border-divider px-3 py-2.5 text-xs">
        <DetailRow label="Microphone">{micLabel ?? "Default microphone"}</DetailRow>
        <DetailRow label="Audio">
          <span data-testid="voice-session-mic">{micStatus(details)}</span>
        </DetailRow>
        {providerName && <DetailRow label="Transcription">{providerName}</DetailRow>}
        <DetailRow label="Type">{KIND_LABEL[kind]}</DetailRow>
        <DetailRow label="AI correction">{correctionEnabled ? "On" : "Off"}</DetailRow>
        <DetailRow label="Target lock">{locked ? "On" : "Off"}</DetailRow>
      </dl>
    </div>
  );
}
