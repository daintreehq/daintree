import { opensWithVoiceCommand } from "@shared/utils/voiceAgentCommands";

// A spoken "send it" fires a prompt at an agent with no key press to second-
// guess it, so a stray utterance must not send a near-empty draft. A draft
// that opens with a command ("/compact") was asked for, however short.
const SPOKEN_SEND_MIN_WORDS = 3;

// Chinese and Japanese write words without spaces between them, so a run of
// those scripts is counted by its words rather than as one.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

let wordSegmenter: Intl.Segmenter | null | undefined;

function unspacedWords(token: string): number {
  wordSegmenter ??=
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;
  if (!wordSegmenter) return [...token].filter((c) => UNSPACED_SCRIPT.test(c)).length;
  let words = 0;
  for (const segment of wordSegmenter.segment(token)) if (segment.isWordLike) words++;
  return words;
}

export function isSpokenSendable(draft: string): boolean {
  if (opensWithVoiceCommand(draft)) return true;
  let words = 0;
  for (const token of draft.split(/\s+/)) {
    if (!/[\p{L}\p{N}]/u.test(token)) continue;
    words += UNSPACED_SCRIPT.test(token) ? unspacedWords(token) : 1;
    if (words >= SPOKEN_SEND_MIN_WORDS) return true;
  }
  return false;
}
