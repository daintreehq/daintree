import type { HostId } from "./remoteHosts.js";

/**
 * Canonical voice session phase types shared across main process, preload, and renderer.
 *
 * All layers must import from here — never re-declare inline. This ensures TypeScript
 * catches phase mismatches at compile time across the IPC boundary.
 */

/**
 * The phase of the voice recording session.
 *
 * - idle: No active session.
 * - arming: Renderer-only pre-recording state. Fires synchronously on hotkey
 *   press so the target panel and toolbar can show a visual cue (~<50ms)
 *   before audio init begins (~200ms). The backend never emits this status
 *   over IPC; it lives only in the renderer voice store and is overwritten
 *   by `beginSession()` once `connecting` arrives.
 * - connecting: WebSocket to OpenAI Realtime is being established.
 * - recording: The transcription backend is ready; live transcription in
 *   progress. Says nothing about whether the mic is delivering real audio —
 *   that is the renderer-only `micSignal` in the voice store (#13105).
 * - paused: Session alive (WebSocket open) but audio capture suspended;
 *   the PCM worklet stops forwarding chunks until the user resumes. An
 *   auto-stop timer terminates the session if pause exceeds 60s.
 * - reconnecting: Connection dropped mid-session; retrying with backoff while
 *   buffering captured audio. The session is still active from the user's view.
 * - finishing: Session stop requested; draining final transcription from OpenAI.
 * - error: Session terminated due to a connection or transcription error.
 */
export type VoiceInputStatus =
  | "idle"
  | "arming"
  | "connecting"
  | "recording"
  | "paused"
  | "reconnecting"
  | "finishing"
  | "error";

/**
 * Why main ended a dictation session. Sent once per session on
 * `voice-input:session-ended`, keyed by the renderer-minted session id.
 *
 * - stopped: the owner stopped a running session and its transcription drained.
 * - cancelled: it ended before anything was committed: stopped before the
 *   provider came up, or its owning view went away.
 * - superseded: a newer start replaced it.
 * - failed: the provider failed to start or died mid-session.
 */
export type VoiceSessionEndReason = "stopped" | "cancelled" | "superseded" | "failed";

/** Where a recognition hint came from. */
export type VoiceKeytermSource =
  | "dictionary"
  | "projectDictionary"
  | "project"
  | "repository"
  | "names"
  | "commands"
  | "branch"
  | "terminal";

export interface VoiceSentTerm {
  term: string;
  source: VoiceKeytermSource;
}

/**
 * What the most recent dictation handed its transcription provider, kept in
 * main's memory for that one session. `sent` is null until the provider has
 * reported its request, and empty when it went out with no terms.
 * `keytermAttempt` is the retry step of a provider that takes its terms on the
 * socket URL (Deepgram, Grok): after a rejection it re-sends a trimmed list,
 * then none. `endedBeforeSending` marks a session that ended
 * before the provider reported a request (rejected, stopped while connecting,
 * or the request failed to send), so its empty `sent` is not a provider limit.
 */
export interface LastDictationTerms {
  sessionId: string;
  provider: "openai" | "deepgram" | "grok";
  /**
   * How many terms assembly gathered, before the provider's own limits. Zero
   * until assembly lands, which for OpenAI can be after its provider starts.
   */
  assembledCount: number;
  sent: VoiceSentTerm[] | null;
  keytermAttempt?: "full" | "trimmed" | "none";
  endedBeforeSending?: true;
  /** The session dictated an instruction to rewrite selected text, not prompt text. */
  rewrite?: true;
  startedAt: number;
}

/**
 * A dictation session another view owns. Main tells every view about the live
 * session on `voice-input:live-session`, except the one that owns it, so the
 * dictation key can stop it from anywhere and the view can say where it runs.
 * Views on every host hear it: the Shell runs one dictation for all of them
 * (#14773).
 */
export interface VoiceSessionElsewhere {
  sessionId: string;
  /** The host the owning view's workspace is on: `LOCAL_HOST_ID` for this machine. */
  hostId: HostId;
  /** That workspace, a project or a scratch, as its own host knows it. */
  projectId: string | null;
  projectName: string | null;
  /** What the owner last reported, or null until its first report lands. */
  details: VoiceSessionSnapshot | null;
}

/**
 * Proof of capture (#13105). pending: no real samples yet; live: a chunk above
 * the noise floor arrived, latched for the session; silent: still none after
 * the grace window.
 */
export type VoiceMicSignal = "pending" | "live" | "silent";

/** What the session records: prompt text, a rewrite instruction, or a Canopy reply. */
export type VoiceSessionKind = "dictation" | "rewrite" | "canopy-reply";

/** The states a live session shows its control panel in (#14920). */
export type VoiceSessionPhase =
  "arming" | "connecting" | "recording" | "paused" | "reconnecting" | "finishing";

/** The target pane's icon, as the owner derived it from the pane's identity. */
export interface VoiceTargetChrome {
  iconId: string | null;
  color?: string;
  label: string;
  isAgent: boolean;
  agentId: string | null;
  processId: string | null;
  runtimeKind: "agent" | "process" | "panel" | "none";
  hasExited: boolean;
}

/**
 * The session's clock at `at` (epoch ms): a view adds the time since, so
 * nothing is sent as it ticks. Elapsed is wall time, pauses included; paused
 * time grows while `paused`; an auto-stop counts down.
 */
export interface VoiceSessionClockAnchor {
  at: number;
  elapsedMs: number;
  pausedMs: number;
  paused: boolean;
  autoStop: { reason: "pause" | "idle"; remainingMs: number } | null;
}

/** The most of the words so far a snapshot carries: the panel shows their tail. */
export const VOICE_SNAPSHOT_TRANSCRIPT_MAX_LENGTH = 400;

/**
 * The live session as its owner's control panel shows it, reported to main
 * and passed on to every other view, so their indicator and panel match the
 * owner's (#14921). The input level travels apart, on `voice-input:live-level`,
 * and the provider and the owning workspace come from main.
 */
export interface VoiceSessionSnapshot {
  phase: VoiceSessionPhase;
  kind: VoiceSessionKind;
  targetTitle: string;
  targetChrome: VoiceTargetChrome | null;
  /** The host the words go to: the owner's own, or a Canopy reply's terminal's. */
  targetHostId: HostId | null;
  projectName: string | null;
  worktreeLabel: string | null;
  micLabel: string | null;
  micSignal: VoiceMicSignal;
  micNotice: { kind: "lost" | "silent"; bluetooth: boolean; appReplaced?: true } | null;
  /** The owner is warning that its auto-stop is close: of the pause, or of no new words. */
  stopWarning: boolean;
  correctionEnabled: boolean;
  locked: boolean;
  wordCount: number;
  /** The end of the words so far, at most VOICE_SNAPSHOT_TRANSCRIPT_MAX_LENGTH. */
  transcript: string;
  /** The provider the owner started on, as its panel names it; null with no clock. */
  provider: "openai" | "deepgram" | "grok" | null;
  /** Null once the session is stopping. */
  clock: VoiceSessionClockAnchor | null;
}

/** The owner's report of its live session, `voice-input:publish-details`. */
export interface VoicePublishDetailsRequest {
  sessionId: string;
  details: VoiceSessionSnapshot;
}

/** Another view's panel pausing or resuming the live session. */
export interface VoicePauseRequest {
  sessionId: string;
  paused: boolean;
}

/**
 * The live session's input level, on the same 0-1 scale as the owner's meter.
 * Sent only to the views on screen that don't own it, as main hears each chunk.
 */
export interface VoiceLiveLevel {
  sessionId: string;
  level: number;
}

/** The owner's meter scale: a PCM chunk's RMS (0-1) as a 0-1 level. */
export function voiceLevelFromRms(rms: number): number {
  return Math.min(1, rms * 6);
}

/** The longest name a view gives its workspace when it starts a dictation. */
export const VOICE_WORKSPACE_NAME_MAX_LENGTH = 200;

/**
 * Another view's indicator asked to be taken to the live session: sent to the
 * owner, which brings its target forward, and to the view on screen in the
 * owner's window, which goes to `workspaceId` on `hostId`, switching the
 * window's host when it is on another.
 */
export interface VoiceRevealRequest {
  sessionId: string;
  hostId: HostId;
  workspaceId: string | null;
}

/**
 * The dictation key stopping the live session from outside its view: another
 * view's key, or a page (a browser panel, a portal tab) handing it over. Sent
 * by the other view to main, and by main on to the owner. `returnToTarget`
 * takes the person back to the dictation's pane once it stops (#14791): main
 * brings the owner's window and workspace forward, and the owner puts the
 * keyboard in its composer. A stop nobody pressed the key for, such as an
 * agent's, leaves focus where it is.
 */
export interface VoiceStopRequest {
  sessionId: string;
  returnToTarget?: boolean;
}

/**
 * The live session as one view sees it: `session` is null when none is live or
 * that view owns it. `revision` grows with every change, so a pulled snapshot
 * can't overwrite a newer push.
 */
export interface VoiceLiveSessionUpdate {
  revision: number;
  session: VoiceSessionElsewhere | null;
}

/**
 * How a `voice-input:start` call came out. A provider that couldn't start
 * reports why in `error`, for the user; it is never logged.
 */
export type VoiceStartOutcome =
  { status: "started" } | { status: "superseded" } | { status: "failed"; error: string };

/**
 * How a `voice-input:rewrite` call came out. Only `replace` carries text.
 *
 * - replace: the model's rewrite, which kept every protected span.
 * - no_change: the model left the selection as it was.
 * - rejected: the rewrite dropped or changed a reference, backticked span,
 *   URL, flag or path, so it was discarded.
 * - unavailable: no OpenAI API key to send it with.
 * - failed: the request failed, timed out or came back unusable.
 */
export type VoiceRewriteOutcome =
  | { status: "replace"; text: string }
  | { status: "no_change" }
  | { status: "rejected" }
  | { status: "unavailable" }
  | { status: "failed" };

/**
 * The lifecycle phase of the transcript within a single voice panel buffer.
 * This is a renderer-level concept — it is derived from store state and is never
 * sent over IPC directly.
 *
 * - idle: No active transcription in this panel buffer.
 * - interim: A live segment is in flight; liveText is non-empty.
 * - utterance_final: A final transcript segment was accepted; liveText cleared.
 * - stable: Ready for the next utterance.
 */
export type VoiceTranscriptPhase = "idle" | "interim" | "utterance_final" | "stable";

/**
 * Returns true when the voice session is in an active phase (i.e. not idle,
 * arming, or error). `arming` is excluded deliberately: it is the pre-audio
 * confirmation window, and including it would cause the toggle guard to treat
 * a second hotkey press during arming as a stop instead of letting the
 * in-flight start complete.
 */
export function isActiveVoiceSession(status: VoiceInputStatus): boolean {
  return (
    status === "connecting" ||
    status === "recording" ||
    status === "paused" ||
    status === "reconnecting" ||
    status === "finishing"
  );
}

/**
 * Severity classification for a voice-input error. Drives the renderer's
 * recovery behavior: transient errors keep the session alive while the main
 * process reconnects; fatal errors tear down the session and surface a toast.
 *
 * - transient: a recoverable transport or rate-limit fault — the main process
 *   is already reconnecting (or will, on the next close). The user sees the
 *   "reconnecting" status but the session intent is preserved. Also a report
 *   that changes nothing about the session, such as `VOICE_STOP_AUDIO_LOST_CODE`.
 * - fatal: requires user action (auth/quota/permission/config) or is
 *   unrecoverable. The session ends.
 */
export type VoiceInputErrorSeverity = "transient" | "fatal";

/**
 * A graceful stop gave up on audio it was holding for a socket that never
 * opened, or for a fresh one after the connection stopped answering. Sent
 * while the stop drains, which is when the renderer otherwise ignores provider
 * errors, so it is one it still shows.
 */
export const VOICE_STOP_AUDIO_LOST_CODE = "stop_audio_lost";

/**
 * Audio a reconnect would have to resend no longer fits what the provider
 * holds for it, so some of the dictation may never be transcribed. The
 * session keeps running; it can also land while a stop drains.
 */
export const VOICE_REPLAY_AUDIO_LOST_CODE = "replay_audio_lost";

/**
 * Structured error payload emitted by the voice input pipeline. Plain
 * serializable shape so it crosses Electron's contextBridge (no class
 * instances, no Error subclasses).
 *
 * `code` is a stable identifier — UI mapping, telemetry, and tests should
 * branch on `code`, not on `message`. `message` carries the user-facing
 * fallback string for surfaces that lack a code mapping.
 */
export interface VoiceInputError {
  severity: VoiceInputErrorSeverity;
  /**
   * Stable error code. For server-emitted errors this mirrors the OpenAI
   * Realtime `error.code` (e.g. `"rate_limit_exceeded"`,
   * `"session_expired"`); for transport errors it's a synthetic code like
   * `"ws_close_1006"` or `"connection_timeout"`; for renderer-side
   * pre-connect failures it's a descriptive slug like `"mic_permission_denied"`.
   */
  code: string;
  /** Human-readable fallback message — shown when no `code` mapping exists. */
  message: string;
  /** OpenAI error payload `param` field, when present. */
  param?: string | null;
}

/** Raised when the provider reports one segment failed; the session keeps running. */
export const TRANSCRIPTION_ITEM_FAILED_CODE = "transcription_item_failed";

/** How many finished dictations the app session keeps for recovery. */
export const MAX_RECENT_DICTATIONS = 20;

/**
 * A finished dictation session, kept in main's memory for the app session so
 * its words can be recovered when they went somewhere wrong (#14637). Never
 * persisted, logged or sent off the machine.
 */
export interface RecentDictation {
  /** The session's renderer identity (`dictationSessionId`). */
  id: string;
  /** What the provider transcribed, paragraph breaks included. */
  rawText: string;
  /** What the AI cleanup returned for the whole session; null when none ran or it changed nothing. */
  correctedText: string | null;
  /** The panel the session dictated into, as it was when the session ended. Display only. */
  target: {
    panelId: string;
    panelTitle?: string;
    projectId?: string;
    projectName?: string;
    worktreeId?: string;
    worktreeLabel?: string;
  };
  endedAt: number;
}
