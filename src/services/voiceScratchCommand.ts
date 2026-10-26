import { makeDraftKey } from "@/lib/draftKey";

// Only an utterance that is the command and nothing else, so "I'll scratch that
// idea" stays literal. Trailing punctuation is the transcriber's own.
const SCRATCH_COMMAND_RE = /^\s*(?:scratch|delete)\s+that[\s.,;:!?]*$/i;

export function isScratchCommand(text: string): boolean {
  return SCRATCH_COMMAND_RE.test(text);
}

// The draft each scratch left, keyed by draft like a landed correction. An
// Escape that cancels a dictation records one too. The composer takes it with
// the revision the write bumped, and keeps its undo history even when the
// write emptied the draft: that is an edit, not a send.
const scratched = new Map<string, string>();

export function recordScratchLanded(
  panelId: string,
  projectId: string | undefined,
  draft: string
): void {
  scratched.set(makeDraftKey(panelId, projectId), draft);
}

/**
 * Whether `draft` is still the one a scratch left in this panel's draft.
 * Taken either way, so a later send that empties the draft is never mistaken
 * for one.
 */
export function takeScratchLanded(
  panelId: string,
  projectId: string | undefined,
  draft: string
): boolean {
  const key = makeDraftKey(panelId, projectId);
  const left = scratched.get(key);
  if (left === undefined) return false;
  scratched.delete(key);
  return left === draft;
}
