import { z } from "zod";
import { dispatchCarriesOptionLikePrompt } from "./dispatchAgentLaunch.js";

/**
 * Longest hand-off, in characters. Continue Session's runs to about 11,500
 * (five requests and the last reply, quoted), so this leaves room; the launch
 * command's own limits still apply, as they do to `agent.launch`'s prompt.
 */
export const ASSISTANT_HANDOFF_MAX_LENGTH = 16_384;

// The launch command carries line breaks and tabs by having the shell build
// them (`quoteLaunchPrompt`). Any other control character makes the spawn
// refuse the command, which for the global assistant would be after its run
// was already stopped.
// eslint-disable-next-line no-control-regex
const UNSENDABLE_CHARACTER = /[\x00-\x08\x0B-\x1F\x7F]/;

/** Whether the launch command can carry this hand-off as the agent's first turn. */
export function isSendableHandoff(text: string): boolean {
  return !UNSENDABLE_CHARACTER.test(text.replace(/\r\n/g, "\n"));
}

/**
 * A hand-off an assistant session starts from (#18140), checked before
 * anything is stopped, claimed or asked.
 */
export const AssistantHandoffPromptSchema = z
  .string()
  .max(ASSISTANT_HANDOFF_MAX_LENGTH)
  .refine(isSendableHandoff, { message: "A hand-off can't hold control characters" });

/**
 * A hand-off a run must start from: not blank, and never one a CLI would read
 * as an option rather than a first turn.
 */
export function isUsableHandoff(text: string): boolean {
  return (
    text.trim().length > 0 &&
    isSendableHandoff(text) &&
    text.length <= ASSISTANT_HANDOFF_MAX_LENGTH &&
    !dispatchCarriesOptionLikePrompt({ prompt: text })
  );
}
