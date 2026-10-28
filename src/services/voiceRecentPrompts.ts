import { useTerminalInputStore, type SentPrompt } from "@/store/terminalInputStore";
import { VOICE_RECENT_PROMPTS_MAX } from "@shared/config/voiceCorrection";

// The window's start moves this many sends at a time, so most sends only add to
// the end of what cleanup is shown and its cached prefix still holds the
// prompts before them.
const RECENT_PROMPT_STEP = 3;

// Older than this, a prompt belongs to a session the dictation isn't part of.
const RECENT_PROMPT_MAX_AGE_MS = 60 * 60_000;

/**
 * The prompts a cleanup request carries, oldest first: the last few sends to
 * the terminal, in a window whose start moves three sends at a time (between
 * four and six once there are six), less any sent over an hour ago.
 */
export function selectRecentPrompts(sent: readonly SentPrompt[], now: number): string[] {
  const latest = sent[sent.length - 1];
  if (!latest) return [];
  const over = latest.seq + 1 - VOICE_RECENT_PROMPTS_MAX;
  const start = over > 0 ? Math.ceil(over / RECENT_PROMPT_STEP) * RECENT_PROMPT_STEP : 0;
  return sent
    .filter((prompt) => prompt.seq >= start && now - prompt.sentAt <= RECENT_PROMPT_MAX_AGE_MS)
    .map((prompt) => prompt.text);
}

/** What this view last sent to `terminalId`, as a cleanup request carries it. */
export function recentPromptsFor(terminalId: string, now = Date.now()): string[] {
  return selectRecentPrompts(useTerminalInputStore.getState().getSentPrompts(terminalId), now);
}
