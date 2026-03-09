/**
 * Canonical voice session phase types shared across main process, preload, and renderer.
 *
 * All layers must import from here — never re-declare inline. This ensures TypeScript
 * catches phase mismatches at compile time across the IPC boundary.
 */

/**
 * The phase of the voice recording session as reported over IPC.
 *
 * - idle: No active session.
 * - connecting: WebSocket to Deepgram is being established.
 * - recording: Connected and receiving audio; live transcription in progress.
 * - finishing: Session stop requested; draining final transcription from Deepgram.
 * - error: Session terminated due to a connection or transcription error.
 */
export type VoiceInputStatus = "idle" | "connecting" | "recording" | "finishing" | "error";

/**
 * The lifecycle phase of the transcript within a single voice panel buffer.
 * This is a renderer-level concept — it is derived from store state and is never
 * sent over IPC directly.
 *
 * - idle: No active transcription in this panel buffer.
 * - interim: A live segment is in flight; liveText is non-empty.
 * - utterance_final: Deepgram finalized the utterance; liveText cleared, no pending corrections.
 * - paragraph_pending_ai: The paragraph was flushed and is awaiting AI correction.
 * - stable: All corrections resolved; ready for the next utterance.
 */
export type VoiceTranscriptPhase =
  | "idle"
  | "interim"
  | "utterance_final"
  | "paragraph_pending_ai"
  | "stable";

/**
 * Returns true when the voice session is in an active phase (i.e. not idle or error).
 * Use this instead of comparing against multiple status strings inline.
 */
export function isActiveVoiceSession(status: VoiceInputStatus): boolean {
  return status === "connecting" || status === "recording" || status === "finishing";
}
