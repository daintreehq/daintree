import { logInfo } from "@/utils/logger";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

/** What asked for a voice send: the key, the session panel's Send, a spoken "send it", or Enter. */
export type VoiceSendAsker = "stop_and_send_key" | "session_panel_send" | "spoken_send" | "enter";

/** The askers that stop the dictation and send in one go. */
export type VoiceStopAndSendAsker = Extract<
  VoiceSendAsker,
  "stop_and_send_key" | "session_panel_send"
>;

/**
 * Why a send request went nowhere. Codes only: the line is read to answer "I
 * pressed send and it didn't go", and nothing the person said or typed may
 * ride along.
 */
export type VoiceSendRefusal =
  // A send for this draft is already waiting, and this request couldn't join it.
  | "already_waiting"
  | "composer_disabled"
  // No composer is mounted to send from, or Canopy's reply is off screen.
  | "composer_unavailable"
  | "draft_empty"
  | "draft_too_short"
  // The composer took the request and held the send back (an upload still going).
  | "send_held"
  | "send_failed"
  | "no_session"
  | "session_finishing"
  // The dictation runs in another view, which stops without sending.
  | "session_elsewhere"
  // A spoken "send it" that the session had moved on from when it was heard.
  | "target_changed"
  | "not_recording"
  | "stop_not_users"
  | "session_discarded"
  | "scratch_precedence";

export const VOICE_SEND_REFUSED_MESSAGE = "[VoiceSend] Request refused";

/**
 * Logs one send request that was refused or did nothing. `sessionId` defaults to
 * the dictation now in the panel's draft; a request that can't name a panel
 * (another view's session) passes `null` for it.
 */
export function logVoiceSendRefused(request: {
  asker: VoiceSendAsker;
  reason: VoiceSendRefusal;
  panelId: string | null;
  sessionId?: string | null;
}): void {
  const { asker, reason, panelId } = request;
  const sessionId =
    request.sessionId !== undefined
      ? request.sessionId
      : panelId
        ? (useVoiceRecordingStore.getState().panelBuffers[panelId]?.dictationSessionId ?? null)
        : null;
  // Built field by field: nothing else the caller holds may reach the line.
  logInfo(VOICE_SEND_REFUSED_MESSAGE, { asker, reason, panelId, sessionId });
}
