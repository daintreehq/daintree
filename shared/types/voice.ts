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
 * - recording: Connected and receiving audio; live transcription in progress.
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
 *   "reconnecting" status but the session intent is preserved.
 * - fatal: requires user action (auth/quota/permission/config) or is
 *   unrecoverable. The session ends.
 */
export type VoiceInputErrorSeverity = "transient" | "fatal";

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
