// Only an utterance that is the command and nothing else, so "I'll scratch that
// idea" stays literal. Trailing punctuation is the transcriber's own.
const SCRATCH_COMMAND_RE = /^\s*(?:scratch|delete)\s+that[\s.,;:!?]*$/i;

export function isScratchCommand(text: string): boolean {
  return SCRATCH_COMMAND_RE.test(text);
}
