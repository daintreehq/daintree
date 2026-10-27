import { opensWithVoiceCommand } from "@shared/utils/voiceAgentCommands";

// A spoken "send it" fires a prompt at an agent with no key press to second-
// guess it, so a stray utterance must not send a near-empty draft. A draft
// that opens with a command ("/compact") was asked for, however short.
const SPOKEN_SEND_MIN_WORDS = 3;

export function isSpokenSendable(draft: string): boolean {
  if (opensWithVoiceCommand(draft)) return true;
  let words = 0;
  for (const token of draft.split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(token) && ++words >= SPOKEN_SEND_MIN_WORDS) return true;
  }
  return false;
}
