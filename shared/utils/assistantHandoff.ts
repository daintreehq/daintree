import { z } from "zod";
import { dispatchCarriesOptionLikePrompt } from "./dispatchAgentLaunch.js";
import { agentCommandDialect } from "./shellEscape.js";

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
 * About the most of a Windows launch script a hand-off may take. PowerShell
 * runs the script as `-EncodedCommand`, UTF-16 in Base64, within a 32,767
 * character command line: some 12,000 characters of script, the rest of which
 * names the CLI, its flags and its environment.
 */
const WINDOWS_HANDOFF_SCRIPT_BUDGET = 9_000;

/** Whether the launch command here can carry the hand-off at all. */
export function handoffFitsLaunchCommand(text: string): boolean {
  if (agentCommandDialect() !== "windows") return true;
  const arg = text.trim().replace(/\r\n/g, "\n");
  // The CLI gets it as one native argument, as `serializeWindowsArgv` writes it
  // (electron/utils/windowsAgentLaunch.ts), and the script then quotes that
  // command line for PowerShell, doubling every single quote.
  const native = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
  const scripted = native.length + (native.match(/['\u2018-\u201b]/g)?.length ?? 0);
  return scripted <= WINDOWS_HANDOFF_SCRIPT_BUDGET;
}

/**
 * A hand-off a run must start from: not blank, never one a CLI would read as
 * an option rather than a first turn, and one the launch command can carry,
 * since the global assistant's run is stopped before its successor starts.
 */
export function isUsableHandoff(text: string): boolean {
  return (
    text.trim().length > 0 &&
    isSendableHandoff(text) &&
    text.length <= ASSISTANT_HANDOFF_MAX_LENGTH &&
    !dispatchCarriesOptionLikePrompt({ prompt: text }) &&
    handoffFitsLaunchCommand(text)
  );
}
