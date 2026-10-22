import type { AppErrorDetails } from "../types/appError.js";
import { pickAppErrorDetails } from "./ipcErrorSerialization.js";

export interface DecodedAppErrorWire {
  code: string;
  userMessage?: string;
  details?: AppErrorDetails;
  /** The original message that follows the closing `]`. */
  message: string;
}

// The prefix the preload's `_reconstructAppError` packs into `Error.message`,
// the only carrier that survives the contextBridge. Group 2 is the optional
// urlencoded userMessage, group 3 the optional urlencoded JSON details (marked
// by a leading `#`, which a urlencoded userMessage can never start with).
const ENCODED_APP_ERROR_PATTERN =
  /^\[AppError\|([A-Z_]+)(?:\|(?!#)([^\]]*?))?(?:\|#([^\]|]*))?\] (.*)$/s;

function decodeDetails(encoded: string): AppErrorDetails | undefined {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(encoded));
    return pickAppErrorDetails(parsed);
  } catch {
    return undefined;
  }
}

/** Pure: null when the message carries no AppError prefix. */
export function decodeAppErrorWire(message: string): DecodedAppErrorWire | null {
  const match = ENCODED_APP_ERROR_PATTERN.exec(message);
  if (!match) return null;
  const [, code, encodedUserMsg, encodedDetails, original] = match;
  const decoded: DecodedAppErrorWire = { code: code!, message: original ?? message };
  if (encodedUserMsg !== undefined) {
    try {
      decoded.userMessage = decodeURIComponent(encodedUserMsg);
    } catch {
      decoded.userMessage = encodedUserMsg;
    }
  }
  if (encodedDetails !== undefined) {
    const details = decodeDetails(encodedDetails);
    if (details !== undefined) decoded.details = details;
  }
  return decoded;
}
