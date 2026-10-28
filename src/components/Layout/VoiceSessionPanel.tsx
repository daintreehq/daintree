import { useEffect, useRef, type ReactNode } from "react";
import { Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { POPOVER_ROW_HOVER_CLASS } from "@/components/ui/popoverHeader";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import type { TerminalChromeDescriptor } from "@/utils/terminalChrome";
import type { VoiceMicSignal } from "@/store/voiceRecordingStore";

/** The states a session shows its panel in. */
export type VoiceSessionPhase =
  | "arming"
  | "connecting"
  | "recording"
  | "paused"
  | "reconnecting"
  | "finishing";

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
  micNotice: { kind: "lost" | "fallback" | "silent"; bluetooth: boolean } | null;
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
}

const TRANSCRIPT_TAIL_CHARS = 160;
// The meter's floor and smoothing, matched to the toolbar's bars so the two
// agree on what counts as sound.
const NOISE_FLOOR = 0.04;
const TAU_ATTACK = 0.015;
const TAU_RELEASE = 0.08;

function formatClock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function phaseLabel(phase: VoiceSessionPhase, micSignal: VoiceMicSignal): string {
  switch (phase) {
    case "arming":
      return "Arming";
    case "connecting":
    case "recording":
      if (micSignal === "silent") return "No audio";
      if (micSignal !== "live") return "Starting microphone";
      return phase === "connecting" ? "Listening · connecting" : "Listening";
    case "paused":
      return "Paused";
    case "reconnecting":
      return "Reconnecting";
    case "finishing":
      return "Finishing transcription";
  }
}

const KIND_LABEL: Record<VoiceSessionKind, string> = {
  dictation: "Dictation",
  rewrite: "Rewrite instruction",
  "canopy-reply": "Canopy reply",
};

function micStatus({
  micSignal,
  micNotice,
}: Pick<VoiceSessionDetails, "micSignal" | "micNotice">): string {
  if (micNotice?.kind === "lost") return "Disconnected";
  if (micSignal === "silent" || micNotice?.kind === "silent") {
    return micNotice?.bluetooth ? "No audio · Bluetooth" : "No audio";
  }
  const signal = micSignal === "live" ? "Delivering audio" : "Waiting for audio";
  return micNotice?.kind === "fallback" ? `${signal} · fallback` : signal;
}

function autoStopLabel(autoStop: NonNullable<VoiceSessionDetails["autoStop"]>): string {
  const remaining = formatClock(autoStop.remainingMs);
  return autoStop.reason === "pause"
    ? `In ${remaining} unless resumed`
    : `In ${remaining} without new words`;
}

/**
 * The input level as a bar that fills from the left, written from a RAF loop
 * straight to its transform so the panel never re-renders per frame.
 */
function VoiceSessionLevel({ active, readLevel }: { active: boolean; readLevel: () => number }) {
  const fillRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const fill = fillRef.current;
    if (!fill) return;
    if (!active) {
      fill.style.transform = "scaleX(0)";
      return;
    }
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
      fill.style.transform = `scaleX(${Math.min(1, envelope).toFixed(3)})`;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [active, readLevel]);

  return (
    <span
      aria-hidden="true"
      className="relative block h-1 w-full overflow-hidden rounded-full bg-overlay-subtle"
      data-testid="voice-session-level"
    >
      <span
        ref={fillRef}
        className="absolute inset-0 origin-left rounded-full bg-text-secondary"
        style={{ transform: "scaleX(0)" }}
      />
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2 text-xs">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="min-w-0 truncate text-text-primary">{children}</dd>
    </div>
  );
}

/**
 * The toolbar mic's control panel for a live dictation (#14920): where the
 * words go, everything known about the session, and its pause and stop.
 */
export function VoiceSessionPanel({
  details,
  readLevel,
  pauseShortcut,
  stopShortcut,
  onGoToTarget,
  onTogglePause,
  onStop,
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
    pausedMs,
    autoStop,
    correctionEnabled,
    locked,
    wordCount,
    transcript,
  } = details;
  const isPaused = phase === "paused";
  const canPause = phase === "recording" || isPaused;
  const canStop = phase !== "finishing";
  const levelActive = (phase === "recording" || phase === "connecting") && micSignal === "live";
  const tail =
    transcript.length > TRANSCRIPT_TAIL_CHARS
      ? `…${transcript.slice(-TRANSCRIPT_TAIL_CHARS).trimStart()}`
      : transcript;

  return (
    <div className="flex w-80 flex-col" data-testid="voice-session-panel" data-phase={phase}>
      <button
        type="button"
        onClick={onGoToTarget}
        className={cn(
          "flex items-center gap-2 border-b border-divider px-3 py-2 text-left",
          POPOVER_ROW_HOVER_CLASS
        )}
        aria-label={`Go to ${targetTitle}`}
        data-testid="voice-session-target"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-secondary">
          <TerminalIcon chrome={targetChrome ?? undefined} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {targetTitle}
        </span>
      </button>

      <div className="flex flex-col gap-2 px-3 py-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium text-text-primary" data-testid="voice-session-state">
            {phaseLabel(phase, micSignal)}
          </span>
          {elapsedMs !== null && (
            <span className="tabular-nums text-text-secondary" data-testid="voice-session-elapsed">
              {formatClock(elapsedMs)}
              {pausedMs >= 1000 && ` · ${formatClock(pausedMs)} paused`}
            </span>
          )}
        </div>
        <VoiceSessionLevel active={levelActive} readLevel={readLevel} />
      </div>

      <dl className="flex flex-col gap-1 border-t border-divider px-3 py-2">
        {hostName && <DetailRow label="Host">{hostName}</DetailRow>}
        {projectName && <DetailRow label="Project">{projectName}</DetailRow>}
        {worktreeLabel && <DetailRow label="Worktree">{worktreeLabel}</DetailRow>}
        <DetailRow label="Microphone">{micLabel ?? "Default microphone"}</DetailRow>
        <DetailRow label="Audio">
          <span data-testid="voice-session-mic">{micStatus(details)}</span>
        </DetailRow>
        {providerName && <DetailRow label="Transcription">{providerName}</DetailRow>}
        <DetailRow label="Type">{KIND_LABEL[kind]}</DetailRow>
        <DetailRow label="AI correction">{correctionEnabled ? "On" : "Off"}</DetailRow>
        <DetailRow label="Target">{locked ? "Locked" : "Not locked"}</DetailRow>
        {autoStop && (
          <DetailRow label="Auto-stop">
            <span data-testid="voice-session-auto-stop">{autoStopLabel(autoStop)}</span>
          </DetailRow>
        )}
      </dl>

      <div className="flex flex-col gap-1 border-t border-divider px-3 py-2">
        <span className="text-xs text-text-secondary" data-testid="voice-session-words">
          {pluralize(wordCount, "word")}
        </span>
        {tail && (
          <p
            className="line-clamp-3 text-xs text-text-primary select-text"
            data-testid="voice-session-transcript"
          >
            {tail}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-divider px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onTogglePause}
          disabled={!canPause}
          data-testid="voice-session-pause"
        >
          {isPaused ? <Play /> : <Pause />}
          {isPaused ? "Resume" : "Pause"}
          {pauseShortcut && <KbdChord shortcut={pauseShortcut} density="compact" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onStop}
          disabled={!canStop}
          data-testid="voice-session-stop"
        >
          <Square />
          Stop
          {stopShortcut && <KbdChord shortcut={stopShortcut} density="compact" />}
        </Button>
      </div>
    </div>
  );
}
