/**
 * Voice logs leave the machine (console output becomes Sentry breadcrumbs), and
 * everything the voice paths handle can be user content: transcripts, spoken
 * descriptions, resolved paths, keyterms, and provider error messages that
 * quote them back. These helpers reduce a value to a shape that is safe to log.
 */

/**
 * The message of the per-session dictation summary (#14617). The line is for
 * the local log only, so both Sentry breadcrumb filters drop any console line
 * that carries it.
 */
export const VOICE_SESSION_SUMMARY_MESSAGE = "[VoiceSession] Summary";

/** Whether a console line or breadcrumb message is a dictation session summary. */
export function isVoiceSessionSummaryLine(message: unknown): boolean {
  return typeof message === "string" && message.includes(VOICE_SESSION_SUMMARY_MESSAGE);
}

// A type alias, not an interface: the loggers' LogContext is an index signature.
type ErrorLogFields = {
  errorName?: string;
  errorCode?: string | number;
};

export function voiceErrorLogFields(error: unknown): ErrorLogFields {
  if (typeof error !== "object" || error === null) return {};
  const { name, code } = error as { name?: unknown; code?: unknown };
  return {
    ...(typeof name === "string" ? { errorName: name } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { errorCode: code } : {}),
  };
}

type PayloadShape = {
  keys: string[];
  length: number;
};

/** Top-level key names and serialized size of an unrecognised provider event. */
export function voicePayloadShape(payload: unknown): PayloadShape {
  const keys =
    typeof payload === "object" && payload !== null ? Object.keys(payload).sort().slice(0, 20) : [];
  let length = 0;
  try {
    length = JSON.stringify(payload)?.length ?? 0;
  } catch {
    // Unserializable payload: size is diagnostic only.
  }
  return { keys, length };
}
