import {
  VOICE_SESSION_SUMMARY_MESSAGE,
  VoiceSessionReportSchema,
  VoiceSessionSummarySchema,
  type VoiceSessionReport,
  type VoiceSessionSummary,
  type VoiceStopReason,
} from "@shared/types/voiceSessionSummary";
import type { VoiceSessionEndReason } from "@shared/types/voice";
import type { VoiceTranscriptionProvider } from "@shared/types";

/** A press this long before start() entry is still the gesture that began it. */
export const VOICE_PRESS_WINDOW_MS = 1_000;

/** How long a finished session waits for main's report before logging without it. */
export const VOICE_REPORT_WAIT_MS = 10_000;

type Mark = "cue" | "micLive" | "socketReady" | "firstText" | "stopRequested" | "settled";

export type VoiceCorrectionOutcome = "applied" | "unchanged" | "failed" | "discarded";

export interface VoiceSessionTimelineDeps {
  now: () => number;
  log: (message: string, context: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  nextFrame: (callback: () => void) => void;
  onDone: (timeline: VoiceSessionTimeline) => void;
}

/**
 * One dictation session's marks and counts, on the renderer's clock, logged
 * as a single summary line once the session is over, its correction (if any)
 * has come back, and main has reported its side — or main never heard of the
 * session, or its report is overdue. Every mark is first-wins and nothing is
 * recorded once the line is out.
 */
export class VoiceSessionTimeline {
  private readonly startedAt: number;
  private origin: number;
  private originKind: "key" | "call" = "call";
  private readonly marks = new Map<Mark, number>();
  private stopReason: VoiceStopReason | null = null;
  private correctionStartedAt: number | null = null;
  private correctionMs: number | null = null;
  private correction: "none" | VoiceCorrectionOutcome = "none";
  private droppedQueued = 0;
  private charsCommitted = 0;
  private heardSignal = false;
  private provider: VoiceTranscriptionProvider | null = null;
  private backend:
    | { state: "none" | "pending" | "unreported" }
    | { state: "ended"; reason: VoiceSessionEndReason; report: VoiceSessionReport | null } = {
    state: "none",
  };
  private reportTimer: ReturnType<typeof setTimeout> | null = null;
  private done = false;

  constructor(
    readonly sessionId: string,
    private readonly deps: VoiceSessionTimelineDeps,
    pressedAt: number | null
  ) {
    this.startedAt = deps.now();
    this.origin = this.startedAt;
    if (pressedAt !== null) this.notePress(pressedAt);
  }

  /** Moves the origin back to the key press that led to this start, if it did. */
  notePress(at: number): boolean {
    if (this.done || this.originKind === "key") return false;
    if (at > this.startedAt || this.startedAt - at > VOICE_PRESS_WINDOW_MS) return false;
    this.origin = at;
    this.originKind = "key";
    return true;
  }

  mark(name: Mark): void {
    if (this.done || this.marks.has(name)) return;
    this.marks.set(name, this.deps.now());
  }

  /** Marks `name` at the frame that will paint what was just committed. */
  markNextFrame(name: Mark): void {
    if (this.done || this.marks.has(name)) return;
    this.deps.nextFrame(() => this.mark(name));
  }

  setProvider(provider: VoiceTranscriptionProvider): void {
    this.provider = provider;
  }

  addDroppedQueued(chunks: number): void {
    if (!this.done) this.droppedQueued += chunks;
  }

  addCommitted(chars: number): void {
    if (!this.done) this.charsCommitted += chars;
  }

  noteSignal(): void {
    this.heardSignal = true;
  }

  /** The start request went to main, so main will report how the session ended. */
  expectReport(): void {
    if (this.backend.state === "none") this.backend = { state: "pending" };
  }

  reportEnded(reason: VoiceSessionEndReason, report: unknown): void {
    if (this.done || this.backend.state === "ended") return;
    const parsed = VoiceSessionReportSchema.safeParse(report);
    this.backend = { state: "ended", reason, report: parsed.success ? parsed.data : null };
    this.tryLog();
  }

  beginCorrection(): void {
    if (this.done || this.correctionStartedAt !== null) return;
    this.correctionStartedAt = this.deps.now();
  }

  endCorrection(outcome: VoiceCorrectionOutcome): void {
    if (this.done || this.correctionStartedAt === null || this.correctionMs !== null) return;
    this.correctionMs = this.deps.now() - this.correctionStartedAt;
    this.correction = outcome;
    this.tryLog();
  }

  /** The session is over in this view; the first reason given is the one kept. */
  finish(reason: VoiceStopReason): void {
    if (this.done || this.stopReason !== null) return;
    this.stopReason = reason;
    if (this.backend.state === "pending") {
      this.reportTimer = setTimeout(() => {
        this.reportTimer = null;
        if (this.backend.state !== "pending") return;
        this.backend = { state: "unreported" };
        this.tryLog();
      }, VOICE_REPORT_WAIT_MS);
    }
    this.tryLog();
  }

  /** Drops the session without a line (module teardown). */
  dispose(): void {
    this.done = true;
    if (this.reportTimer !== null) clearTimeout(this.reportTimer);
    this.reportTimer = null;
  }

  private tryLog(): void {
    if (this.done || this.stopReason === null) return;
    if (this.correctionStartedAt !== null && this.correctionMs === null) return;
    if (this.backend.state === "pending") return;
    this.dispose();
    const summary = VoiceSessionSummarySchema.safeParse(this.buildSummary(this.stopReason));
    if (summary.success) {
      this.deps.log(VOICE_SESSION_SUMMARY_MESSAGE, { sessionId: this.sessionId, ...summary.data });
    } else {
      // Paths only: a rejected value is exactly what must stay out of the log.
      this.deps.warn("[VoiceSession] Summary rejected", {
        sessionId: this.sessionId,
        fields: summary.error.issues.map((issue) => issue.path.join(".")),
      });
    }
    this.deps.onDone(this);
  }

  private since(mark: Mark, from = this.origin): number | null {
    const at = this.marks.get(mark);
    return at === undefined ? null : Math.max(0, Math.round(at - from));
  }

  private buildSummary(stopReason: VoiceStopReason): VoiceSessionSummary {
    const backend = this.backend;
    const report = backend.state === "ended" ? backend.report : null;
    const stopAt = this.marks.get("stopRequested");
    return {
      origin: this.originKind,
      stopReason,
      backendEnd:
        backend.state === "ended"
          ? backend.reason
          : backend.state === "unreported"
            ? "unreported"
            : "none",
      cueMs: this.since("cue"),
      micLiveMs: this.since("micLive"),
      socketReadyMs: this.since("socketReady"),
      firstTextMs: this.since("firstText"),
      stopRequestedMs: this.since("stopRequested"),
      stopSettledMs: stopAt === undefined ? null : this.since("settled", stopAt),
      correctionMs: this.correctionMs === null ? null : Math.round(this.correctionMs),
      correction: this.correction,
      droppedQueued: this.droppedQueued,
      charsCommitted: this.charsCommitted,
      audioNoText: this.heardSignal && this.charsCommitted === 0,
      provider: report?.provider ?? this.provider,
      delayTier: report?.delayTier ?? null,
      biasTermCount: report?.biasTermCount ?? null,
      droppedPreStart: report?.droppedPreStart ?? null,
      droppedConnect: report?.droppedConnect ?? null,
      droppedReplay: report?.droppedReplay ?? null,
      reconnects: report?.reconnects ?? null,
      completedSegments: report?.completedSegments ?? null,
      emptyCompletions: report?.emptyCompletions ?? null,
    };
  }
}
