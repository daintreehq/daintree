import { z } from "zod";

/*
 * The one line a dictation session leaves in the log: where its time went, on
 * the renderer's clock, and what went wrong along the way. Every field is a
 * number, an enum or a flag, so no dictated text, panel title or keyterm can
 * ride along; the session id beside it is the only string on the line. Its
 * message (`VOICE_SESSION_SUMMARY_MESSAGE`, in shared/utils/voiceLogFields)
 * keeps it out of telemetry.
 */

export const VOICE_DELAY_TIERS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** How long the OpenAI model buffers audio before emitting a partial transcript. */
export type VoiceDelayTier = (typeof VOICE_DELAY_TIERS)[number];

/** Why the renderer ended a session: the caller that stopped it, or how its start ended. */
export const VOICE_STOP_REASONS = [
  // The dictation key or the toolbar button.
  "user",
  // Push-to-talk: the held key came up, or the window lost focus while held.
  "key_release",
  "window_blur",
  "escape",
  // A send took the draft, or a spoken "send it" ended the dictation.
  "send",
  "panel_closed",
  "mic_lost",
  "pause_timeout",
  "idle_timeout",
  "sleep",
  "wake",
  // The backend reported a fatal error, or went idle on its own.
  "provider_error",
  "provider_ended",
  // A newer start in this view replaced it.
  "retarget",
  // A start in another view replaced it.
  "superseded",
  "start_failed",
  // Abandoned before it began: a second press while arming, or a newer start.
  "cancelled",
] as const;

export type VoiceStopReason = (typeof VOICE_STOP_REASONS)[number];

const count = z.number().int().nonnegative();
const ms = z.number().nonnegative().nullable();

/**
 * What main alone saw of a session, sent with `voice-input:session-ended`.
 * Null where main ended the session before it got that far.
 */
export const VoiceSessionReportSchema = z
  .object({
    provider: z.enum(["openai", "deepgram", "grok"]).nullable(),
    delayTier: z.enum([...VOICE_DELAY_TIERS, "none"]).nullable(),
    // Not "keytermCount": the logger blanks any field whose name holds "key".
    biasTermCount: count.nullable(),
    // Audio main held for a session still starting, past its cap.
    droppedPreStart: count,
    // Audio the provider held while connecting or reconnecting, past its cap.
    droppedConnect: count,
    // Unacknowledged audio the provider evicted from its replay ledger.
    droppedReplay: count,
    reconnects: count,
    completedSegments: count,
    emptyCompletions: count,
  })
  .strict();

export type VoiceSessionReport = z.infer<typeof VoiceSessionReportSchema>;

/**
 * What main made of one passage's cleanup: a code, never text. `skipped` is a
 * passage it never sent.
 */
export const VOICE_CORRECTION_VERDICTS = [
  "replaced",
  // The model left the passage as it was.
  "unchanged",
  // Cleanup off, nothing to clean, or a passage over the length cap.
  "skipped",
  // The request failed, was cancelled, or came back unusable.
  "failed",
  "timed_out",
] as const;

export type VoiceCorrectionVerdict = (typeof VOICE_CORRECTION_VERDICTS)[number];

/**
 * Where each passage of a session's cleanup ended up. A passage is counted in
 * exactly one field, so every field but `sent` adds up to it.
 */
export const VoiceCorrectionPassagesSchema = z
  .object({
    sent: count,
    applied: count,
    unchanged: count,
    skipped: count,
    failed: count,
    timedOut: count,
    // The draft was sent or edited before the reply could land.
    dropped: count,
    // The reply came back but its place in the draft was gone.
    unlanded: count,
  })
  .strict();

export type VoiceCorrectionPassages = z.infer<typeof VoiceCorrectionPassagesSchema>;

/**
 * Main's share of one passage's cleanup, sent back with its result: building
 * the request, and the OpenAI round trip, which is null when none went out.
 */
export const VoiceCorrectionTimingSchema = z
  .object({
    prepMs: z.number().nonnegative(),
    requestMs: ms,
  })
  .strict();

export type VoiceCorrectionTiming = z.infer<typeof VoiceCorrectionTimingSchema>;

export const VoiceSessionSummarySchema = z
  .object({
    origin: z.enum(["key", "call"]),
    stopReason: z.enum(VOICE_STOP_REASONS),
    // How main ended it; `none` when main never heard of it, `unreported` when
    // its report never arrived.
    backendEnd: z.enum(["stopped", "cancelled", "superseded", "failed", "none", "unreported"]),
    // From the origin.
    cueMs: ms,
    micLiveMs: ms,
    socketReadyMs: ms,
    firstTextMs: ms,
    stopRequestedMs: ms,
    // From the stop request to the last committed text.
    stopSettledMs: ms,
    correctionMs: ms,
    // Its parts: main building the request, the OpenAI round trip, and the
    // draft taking the result. Main's two are the last passage back's, and
    // null where its reply never said.
    correctionPrepMs: ms,
    correctionRequestMs: ms,
    correctionApplyMs: ms,
    correction: z.enum(["none", "applied", "unchanged", "failed", "discarded"]),
    // The reasons behind it, passage by passage; all zero when no cleanup ran.
    correctionPassages: VoiceCorrectionPassagesSchema,
    // Chunks of a long dictation sent for cleanup while it ran. The correction
    // fields above are the stop-time pass, over what came after the last one.
    correctionChunks: count,
    // What became of the chunks' passages, and of the passes after the stop
    // that cleaned again what a chunk couldn't land: every attempt counted.
    correctionChunkPassages: VoiceCorrectionPassagesSchema,
    // Audio the renderer held before the start request, past its cap.
    droppedQueued: count,
    charsCommitted: count,
    // A chunk cleared the signal floor, yet nothing reached the draft.
    audioNoText: z.boolean(),
    // Main's report; null where it never arrived. The provider falls back to
    // the renderer's own reading of the settings.
    provider: VoiceSessionReportSchema.shape.provider,
    delayTier: VoiceSessionReportSchema.shape.delayTier,
    biasTermCount: VoiceSessionReportSchema.shape.biasTermCount,
    droppedPreStart: count.nullable(),
    droppedConnect: count.nullable(),
    droppedReplay: count.nullable(),
    reconnects: count.nullable(),
    completedSegments: count.nullable(),
    emptyCompletions: count.nullable(),
  })
  .strict();

export type VoiceSessionSummary = z.infer<typeof VoiceSessionSummarySchema>;
